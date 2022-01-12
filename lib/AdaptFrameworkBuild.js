import _ from'lodash';
import AdaptCli from './AdaptCli.js';
import { add as addToDate } from 'date-fns';
import { App, Events, Hook } from 'adapt-authoring-core';
import fs from 'fs-extra';
import path from'path';
import zipper from 'zipper';
/**
 * Encapsulates all behaviour needed to build a single Adapt course instance
 * @extends {Events}
 */
class AdaptFrameworkBuild extends Events {
  /**
   * Imports a course zip to the database
   * @param {AdaptFrameworkBuildOptions} options
   * @return {Promise} Resolves to this AdaptFrameworkBuild instance
   */
  static async run(options) {
    const instance = new AdaptFrameworkBuild(options);
    await instance.build();
    return instance;
  }
  /**
   * Returns a timestring to be used for an adaptbuild expiry
   * @return {String}
   */
  static async getBuildExpiry() {
    const framework = await App.instance.waitForModule('adaptframework');
    const [amount, unit] = framework.getConfig('buildLifespan').split(' ');
    return addToDate(Date.now(), { [unit.toLowerCase()]: amount }).toISOString();
  }
  /**
   * Options to be passed to AdaptFrameworkBuild
   * @typedef {Object} AdaptFrameworkBuildOptions
   * @property {String} action The type of build to execute
   * @property {String} courseId The course  to build
   * @property {String} userId The user executing the build
   * @property {String} expiresAt When the build expires
   * 
   * @constructor
   * @param {AdaptFrameworkBuildOptions} options
   */
  constructor({ action, courseId, userId, expiresAt }) {
    super();
    /**
     * The build action being performed
     * @type {String}
     */
    this.action = action;
    /**
     * Shorthand for checking if this build is a preview
     * @type {Boolean}
     */
    this.isPreview = action === 'preview';
    /**
     * Shorthand for checking if this build is a publish
     * @type {Boolean}
     */
    this.isPublish = action === 'publish';
    /**
     * Shorthand for checking if this build is an export
     * @type {Boolean}
     */
    this.isExport = action === 'export';
    /**
     * The _id of the course being build
     * @type {String}
     */
    this.courseId = courseId;
    /**
     * All JSON data describing this course
     * @type {Object}
     */
    this.expiresAt = expiresAt;
    /**
     * All JSON data describing this course
     * @type {Object}
     */
    this.courseData = {};
    /**
     * All metadata related to assets used in this course
     * @type {Object}
     */
    this.assetData = {};
    /**
     * Metadata describing this build attempt
     * @type {Object}
     */
    this.buildData = {};
    /**
     * A map of _ids for use with 'friendly' IDs
     * @type {Object}
     */
    this.idMap = {};
    /**
     * _id of the user initiating the course build
     * @type {String}
     */
    this.userId = userId;
    /**
     * The build output directory
     * @type {String}
     */
    this.dir = '';
    /**
     * The course content directory
     * @type {String}
     */
    this.courseDir = '';
    /**
     * The final location of the build
     * @type {String}
     */
     this.location = '';
    /**
     * List of plugins used in this course
     * @type {Array<Object>}
     */
    this.enabledPlugins = [];
    /**
     * List of plugins NOT used in this course
     * @type {Array<Object>}
     */
    this.disabledPlugins = [];
    /**
     * Invoked prior to a course being built.
     * @type {Hook}
     */
     this.preBuildHook = new Hook({ type: Hook.Types.Series, mutable: true });
     /**
      * Invoked after a course has been built.
      * @type {Hook}
      */
     this.postBuildHook = new Hook({ type: Hook.Types.Series, mutable: true });
  }
  /**
   * Runs the Adapt framework build tools to generate a course build
   * @return {Promise} Resolves with the output directory
   */
  async build() {
    const framework = await App.instance.waitForModule('adaptframework');
    if(!this.expiresAt) {
      this.expiresAt = await AdaptFrameworkBuild.getBuildExpiry();
    }
    this.dir = path.join(framework.getConfig('buildDir'), new Date().getTime().toString());
    this.courseDir = path.join(this.dir, 'src', 'course');
    await fs.ensureDir(this.dir);
    await this.loadCourseData();

    await this.preBuildHook.invoke(this);
    await framework.preBuildHook.invoke(this);

    await Promise.all([
      this.copySource(),
      this.copyAssets(),
      this.writeContentJson()
    ]);
    if(!this.isExport) {
      const devMode = !this.isPublish;
      const menu = this.courseData.config.data._menu;
      const theme = this.courseData.config.data._theme;
      await AdaptCli.buildCourse({ devMode, dir: this.dir, menu, theme });
    }
    this.isPreview ? await this.createPreview() : await this.createZip();

    await this.postBuildHook.invoke(this);
    await framework.postBuildHook.invoke(this);

    this.buildData = await this.recordBuildAttempt();
  }
  /**
   * Collects and caches all the DB data for the course being built
   * @return {Promise}
   */
  async loadCourseData() {
    const content = await App.instance.waitForModule('content');
    const [course] = await content.find({ _id: this.courseId, _type: 'course' });
    if(!course) {
      throw this.app.errors.COURSE_NOT_FOUND;
    }
    const langDir = path.join(this.courseDir, 'en');
    this.courseData = {
      course: { dir: langDir, fileName: 'course.json', data: undefined },
      config: { dir: this.courseDir, fileName: 'config.json', data: undefined },
      contentObject: { dir: langDir, fileName: 'contentObjects.json', data: [] },
      article: { dir: langDir, fileName: 'articles.json', data: [] },
      block: { dir: langDir, fileName: 'blocks.json', data: [] },
      component: { dir: langDir, fileName: 'components.json', data: [] }
    };
    await this.loadAssetData();
    const contentItems = [course, ...await content.find({ _courseId: course._id })];
    this.createIdMap(contentItems);
    this.sortContentItems(contentItems);
    await this.cachePluginData();
    this.transformContentItems(contentItems);
  }
  /**
   * Processes and caches the course's assets
   * @return {Promise}
   */
   async loadAssetData() {
    const [assets, courseassets, mongodb] = await App.instance.waitForModule('assets', 'courseassets', 'mongodb');
    const caRecs = await courseassets.find({ _courseId: this.courseId });
    const uniqueAssetIds = new Set(caRecs.map(c => mongodb.ObjectId.parse(c._assetId)));
    const usedAssets = await assets.find({ _id: { $in: [...uniqueAssetIds] } });
    const idMap = {}
    const assetDocs = [];
    await Promise.all(usedAssets.map(async a => {
      assetDocs.push(a);
      if(!idMap[a._id]) idMap[a._id] = `${this.courseData.course.dir}/assets/${a.path}`;
    }));
    this.assetData = { idMap, data: assetDocs };
  }
  /**
   * Generates a list of all plugins which _aren't_ being used in this course
   * @return {Promise}
   */
  async cachePluginData() {
    const contentplugin = await App.instance.waitForModule('contentplugin');
    const all = await contentplugin.find();
    const enabled = this.courseData.config.data._enabledPlugins || [];
    all.forEach(p => enabled.includes(p.name) ? this.enabledPlugins.push(p) : this.disabledPlugins.push(p));
  }
  /**
   * Stores a map of friendlyId values to ObjectId _ids
   */
  createIdMap(items) {
    items.forEach(i => this.idMap[i._id] = i._friendlyId || undefined);
  }
  /**
   * Sorts the course data into the types needed for each Adapt JSON file
   */
  sortContentItems(items) {
    items.forEach(i => {
      switch(i._type) {
        case 'course':
          this.courseData.course.data = i;
          break;
        case 'config':
          this.courseData.config.data = i;
          break;
        case 'menu': case 'page':
          this.courseData.contentObject.data.push(i);
          break;
        default:
          this.courseData[i._type].data.push(i);
      }
    });
  }
  /**
   * Transforms content items into a format recognised by the Adapt framework
   */
  transformContentItems(items) {
    items.forEach(i => {
      // slot any _friendlyIds into the _id field
      ['_courseId', '_parentId'].forEach(k => i[k] = this.idMap[i[k]] || i[k]);
      if(i._friendlyId) {
        i._id = i._friendlyId;
        delete i._friendlyId;
      }
      // replace asset _ids with correct paths
      const idMapEntries = Object.entries(this.assetData.idMap);
      const itemString = idMapEntries.reduce((s,[_id, assetPath]) => {
        const relPath = assetPath.replace(this.courseDir, 'course');
        return s.replace(new RegExp(_id, 'g'), relPath);
      }, JSON.stringify(i));
      Object.assign(i, JSON.parse(itemString));
      // insert expected _component values
      if(i._component) {
        i._component = this.enabledPlugins.find(p => p.name === i._component).targetAttribute.slice(1);
      }
    });
    // move globals to a nested _extensions object as expected by the framework
    this.enabledPlugins.forEach(({ targetAttribute, type }) => {
      let key = `_${type}`;
      if(type === 'component' || type === 'extension') key += 's';
      try {
        _.merge(this.courseData.course.data._globals, {
          [key]: { [targetAttribute]: this.courseData.course.data._globals[targetAttribute] }
        });
        delete this.courseData.course.data._globals[targetAttribute];
      } catch(e) {}
    });
  }
  /**
   * Copies the source code needed for this course
   * @return {Promise}
   */
  async copySource() {
    const { path: fwPath } = await App.instance.waitForModule('adaptframework');
    const blacklist = ['.DS_Store','course', ...this.disabledPlugins.map(p => p.name)];
    await fs.copy(fwPath, this.dir, { filter: f => !blacklist.includes(path.basename(f)) });
    if(this.isExport) await fs.remove(path.join(this.dir, 'node_modules'));
  }
  /**
   * Deals with copying all assets used in this course
   * @return {Promise}
   */
  async copyAssets() {
    const assets = await App.instance.waitForModule('assets');
    return Promise.all(this.assetData.data.map(async a => {
      return fs.copy(await assets.getAssetFullPath(a.path), this.assetData.idMap[a._id]);
    }));
  }
  /**
   * Outputs all course data to the required JSON files
   * @return {Promise}
   */
  async writeContentJson() {
    return Promise.all(Object.values(this.courseData).map(async ({ dir, fileName, data }) => {
      await fs.ensureDir(dir);
      return fs.writeJson(path.join(dir, fileName), data, { spaces: 2 });
    }));
  }
  /**
   * Makes sure the output folder is structured to allow the files to be served statically for previewing
   * @return {Promise}
   */
  async createPreview() {
    const tempName = `${this.dir}_temp`;
    await fs.move(path.join(this.dir, 'build'), tempName);
    await fs.remove(this.dir);
    await fs.move(tempName, this.dir);
    this.location = this.dir;
  }
  /**
   * Creates a zip file containing all files relevant to the type of build being performed
   * @return {Promise}
   */
  async createZip() {
    const zipPath = path.join(this.dir, this.isPublish ? 'build' : '');
    const outputPath = `${this.dir}.zip`;
    await zipper.zip(zipPath, outputPath, { removeSource: true });
    await fs.remove(this.dir);
    this.location = outputPath;
  }
  /**
   * Stored metadata about a build attempt in the DB
   * @return {Promise} Resolves with the DB document
   */
  async recordBuildAttempt() {
    const [framework, jsonschema, mongodb] = await App.instance.waitForModule('adaptframework', 'jsonschema', 'mongodb');
    const validatedData = await jsonschema.validate('adaptbuild', {
      action: this.action,
      courseId: this.courseId,
      location: this.location,
      expiresAt: this.expiresAt,
      createdBy: this.userId,
      versions: this.enabledPlugins.reduce((m, p) => {
        return { ...m, [p.name]: p.version };
      }, { adapt_framework: framework.version })
    });
    return mongodb.insert('adaptbuilds', validatedData);
  }
}

export default AdaptFrameworkBuild;