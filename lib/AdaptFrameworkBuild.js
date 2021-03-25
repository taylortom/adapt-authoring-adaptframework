const _ = require('lodash');
const { App, Events } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');
const zipper = require('zipper');
/**
 * Encapsulates all behaviour needed to build a single Adapt course instance
 */
class AdaptFrameworkBuild extends Events {
  /**
   * Imports a course zip to the database
   * @param {ClientRequest} req
   * @return {Promise} Resolves to this AdaptFrameworkBuild instance
   */
  static async run(req) {
    const instance = new AdaptFrameworkBuild(req);
    await instance.build();
    return instance;
  }
  /**
   * Returns a timestring to be used for an adaptbuild expiry
   * @return {String}
   */
  static async getBuildExpiry() {
    const adaptFramework = await App.instance.waitForModule('adaptFramework');
    const [amount, unit] = adaptFramework.getConfig('buildLifespan').split(' ');
    return moment().add(amount, unit).toISOString();
  }
  /**
   * @constructor
   * @param {ClientRequest} req
   */
  constructor(req) {
    super();
    /**
     * The build action being performed
     * @type {String}
     */
    this.action = req.action;
    /**
     * Shorthand for checking if this build is a preview
     * @type {Boolean}
     */
    this.isPreview = req.action === 'preview';
    /**
     * Shorthand for checking if this build is a publish
     * @type {Boolean}
     */
    this.isPublish = req.action === 'publish';
    /**
     * Shorthand for checking if this build is an export
     * @type {Boolean}
     */
    this.isExport = req.action === 'export';
    /**
     * The _id of the course being build
     * @type {String}
     */
    this.courseId = req.params.id;
    /**
     * All JSON data describing this course
     * @type {Object}
     */
    this.courseData = {};
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
    this.userId = req.auth.user._id.toString();
    /**
     * The build output directory
     * @type {String}
     */
    this.dir = path.join(App.instance.getConfig('tempDir'), 'builds', new Date().getTime().toString());
    /**
     * The course content directory
     * @type {String}
     */
    this.courseDir = path.join(this.dir, 'src', 'course');
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
  }
  /**
   * Runs the Adapt framework build tools to generate a course build
   * @return {Promise} Resolves with the output directory
   */
  async build() {
    const adaptFramework = await App.instance.waitForModule('adaptFramework');

    await fs.ensureDir(this.dir);
    await this.loadCourseData();

    await adaptFramework.preBuildHook.invoke(this);

    await Promise.all([
      this.copySource(),
      this.copyAssets(),
      this.writeContentJson()
    ]);
    if(!this.isExport) {
      await this.execGrunt();
    }
    this.isPreview ? await this.createPreview() : await this.createZip();

    await adaptFramework.postBuildHook.invoke(this);

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
      const e = new Error('No matching course found');
      e.statusCode = 404;
      throw e;
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
    const contentItems = [course, ...await content.find({ _courseId: course._id })];
    this.createIdMap(contentItems);
    this.sortContentItems(contentItems);
    await this.cachePluginData();
    this.transformContentItems(contentItems);
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
    items.forEach(i => this.idMap[i._id] = i.friendlyId || undefined);
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
      // slot any friendlyIds into the _id field
      ['_courseId', '_parentId'].forEach(k => i[k] = this.idMap[i[k]] || i[k]);
      if(i.friendlyId) {
        i._id = i.friendlyId;
        delete i.friendlyId;
      }
      if(i._type === 'component') {
        const plugin = this.enabledPlugins.find(p => p.name === i._component);
        i._component = plugin.targetAttribute.slice(1);
      }
    });
    // move globals to a nested _extensions object as expected by the framework
    this.enabledPlugins.forEach(({ targetAttribute }) => {
      try {
        _.merge(this.courseData.course.data._globals, {
          _extensions: { [targetAttribute]: this.courseData.course.data._globals[targetAttribute] }
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
    const { path: fwPath } = await App.instance.waitForModule('adaptFramework');
    const blacklist = ['.DS_Store','course', ...this.disabledPlugins.map(p => p.name)];
    await fs.copy(fwPath, this.dir, { filter: f => !blacklist.includes(path.basename(f)) });
    if(this.isExport) await fs.remove(path.join(this.dir, 'node_modules'));
  }
  /**
   * Copies all assets used in this course
   * @return {Promise}
   */
  async copyAssets() {
    const [assets, courseassets, mongodb] = await App.instance.waitForModule('assets', 'courseassets', 'mongodb');
    const caRecs = await courseassets.find({ _courseId: this.courseId });
    const uniqueAssetIds = new Set(caRecs.map(c => mongodb.ObjectId.parse(c._assetId)));
    const usedAssets = await assets.find({ _id: { $in: [...uniqueAssetIds] } });
    return Promise.all(usedAssets.map(async a => {
      return fs.copy(await assets.getAssetFullPath(a.path), `${this.courseData.course.dir}/assets/${a.path}`);
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
   * Runs the relevant grunt task to build the course from source
   */
  async execGrunt() {
    return new Promise((resolve, reject) => {
      const { _menu, _theme, _generateSourcemap } = this.courseData.config.data;
      const mode = _generateSourcemap ? 'dev' : 'prod';
      const command = `grunt server-build:${mode} --theme=${_theme} --menu=${_menu}`;
      exec(command, { cwd: this.dir }, async (error, stdout) => {
        const adaptFramework = await App.instance.waitForModule('adaptFramework');
        adaptFramework.log('debug', stdout);
        if(error) return reject(error);
        resolve();
      });
    });
  }
  /**
   * Stored metadata about a build attempt in the DB
   * @return {Promise} Resolves with the DB document
   */
  async recordBuildAttempt() {
    const mdb = await App.instance.waitForModule('mongodb');
    return mdb.insert('adaptbuilds', {
      action: this.action,
      courseId: this.courseId,
      location: this.location,
      expiresAt: await AdaptFrameworkBuild.getBuildExpiry(),
      createdBy: this.userId
    });
  }
}

module.exports = AdaptFrameworkBuild;
