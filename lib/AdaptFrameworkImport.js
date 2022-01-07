import _ from'lodash';
import { App, Events } from 'adapt-authoring-core';
import fs from 'fs-extra';
import globCallback from 'glob';
import path from 'path';
import { promisify } from 'util';
import semver from 'semver';

/** @ignore */const glob = promisify(globCallback);
/**
 * Handles the Adapt framework import process
 * * @extends {Events}
 */
class AdaptFrameworkImport extends Events {
  /**
   * Runs the import
   * @param {ClientRequest} req
   * @return {Promise}
   */
  static async run(req) {
    return new AdaptFrameworkImport(req).import();
  }
  /**
   * Returns the schema to be used for a specific content type
   * @param {Object} data The content item
   * @return {String} The schema name
   */
  static typeToSchema(data) {
    switch(data._type) {
      case 'menu':
      case 'page':
        return 'contentobject';
      case 'component':
        return `${data._component}-${data._type}`;
      default:
        return data._type;
    }
  }
  /**
   * @constructor
   * @param {ClientRequest} req
   */
  constructor(req) {
    super();
    try {
      const course = req.fileUpload.files.course;

      if(!course || !course.originalFilename || !course.filepath) {
        throw new Error();
      }
      /**
       * The name of the import file being imported
       * @type {String}
       */
      this.name = course.originalFilename;
      /**
       * Reference to the package.json data
       * @type {Object}
       */
      this.pkg;
      /**
       * Path that the import will be unzipped to
       * @type {String}
       */
      this.unzipPath = course.filepath.replace(/\\/g, '/');
      /**
       * A cache of the import's content JSON file data (note this is not the DB data used by the application)
       * @type {Object}
       */
      this.contentJson = {
        course: {},
        contentObjects: []
      };
      /**
       * Key/value store of the installed content plugins
       * @type {Object}
       */
      this.usedContentPlugins = {};
      /**
       * All plugins installed during the import as a name -> metadata map
       * @type {Object}
       */
      this.newContentPlugins = {};
      /**
       * Key/value store mapping old component keys to component names
       * @type {Object}
       */
      this.componentNameMap = {};
      /**
       * A key/value map of asset file names to new asset ids
       * @type {Object}
       */
      this.assetMap = {};
      /**
       * A key/value map of old ids to new ids
       * @type {Object}
       */
      this.idMap = {};
      /**
       * The _id of the user initiating the import
       * @type {String}
       */
      this.userId = req.auth.user._id.toString();
      /**
       * User-defined settings related to what is included with the import
       * @type {Object}
       */
       this.settings = {
        importContent: req.body.importContent || true,
        importPlugins: req.body.importPlugins || true,
        updatePlugins: req.body.updatePlugins || false
      };
    } catch(e) {
      throw App.instance.errors.INVALID_COURSE;
    }
  }
  /**
   * Imports a course zip to the database
   * @return {Promise} Resolves with the current import instance
   */
  async import() {
    let error;
    try {
      const [
        assets, 
        content, 
        contentplugin, 
        courseassets, 
        framework
      ] = await App.instance.waitForModule('assets', 'content', 'contentplugin', 'courseassets', 'adaptframework');
      /**
       * Cached module instance for easy access
       * @type {AssetsModule}
       */
      this.assets = assets;
      /**
       * Cached module instance for easy access
       * @type {ContentModule}
       */
      this.content = content;
      /**
       * Cached module instance for easy access
       * @type {ContentPluginModule}
       */
      this.contentplugin = contentplugin;
      /**
       * Cached module instance for easy access
       * @type {CourseAssetsModule}
       */
      this.courseassets = courseassets;
      /**
       * Cached module instance for easy access
       * @type {AdaptFrameworkModule}
       */
      this.framework = framework;

      await this.prepare();
      
      if(this.settings.importContent) {
        await this.importCourseAssets();
      }
      await this.loadCourseData();
      
      if(this.settings.importPlugins) {
        await this.importCoursePlugins();
      }
      if(this.settings.importContent) {
        await this.importCourseData();
      }
    } catch(e) {
      error = e;
      /**
       * Tracks whether the import process has failed with an error
       * @type {Boolean}
       */
      this.hasErrored = true;
    }
    await this.cleanUp(error);
    if(error) throw error;
    return this;
  }
  /**
   * Performs preliminary checks to confirm that a course is suitable for import
   * @return {Promise}
   */
  async prepare() {
    try { // if it's a nested zip, move everything up a level
      const files = await fs.readdir(this.unzipPath);
      if(files.length === 1) {
        const nestDir = `${this.unzipPath}/${files[0]}`;
        await fs.stat(`${nestDir}/package.json`);
        const newDir = path.join(`${this.unzipPath}_2`);
        await fs.move(nestDir, newDir);
        await fs.remove(this.unzipPath);
        this.unzipPath = newDir;
      }
    } catch(e) {
      // nothing to do
    }
    try {
      /** @ignore */this.pkg = await fs.readJson(`${this.unzipPath}/package.json`);
    } catch(e) {
      throw App.instance.errors.IMPORT_INVALID;
    }
    if(!semver.satisfies(this.pkg.version, semver.major(this.framework.version).toString())) {
      throw App.instance.errors.FW_INCOMPAT
        .setData({ installed: this.pkg.version, import: this.framework.version });
    }
  }
  /**
   * Loads and caches all course content
   * @return {Promise}
   */
  async loadCourseData() {
    const usedPluginPaths = await glob(`${this.unzipPath}/src/+(components|extensions|menu|theme)/*`, { absolute: true });
    
    await Promise.all(usedPluginPaths.map(async p => {
      const { version, targetAttribute } = await fs.readJson(`${p}/bower.json`);
      this.usedContentPlugins[p.split('/').pop()] = { path: p, version, targetAttribute };
    }));
    const files = await glob(`${this.unzipPath}/src/course/**/*.json`);
    return Promise.all(files.map(f => this.loadContentFile(f)));
  }
  /**
   * Loads a single content JSON file
   * @return {Promise}
   */
  async loadContentFile(filePath) {
    const contents = await fs.readJson(filePath);
    if(contents._type === 'course') {
      this.contentJson.course = contents;
      return;
    }
    if(path.basename(filePath) === 'config.json') {
      this.contentJson.config = {
        _id: 'config',
        _type: 'config',
        _enabledPlugins: Object.keys(this.usedContentPlugins),
        ...contents
      };
      return;
    }
    if(Array.isArray(contents)) contents.forEach(c => this.contentJson.contentObjects[c._id] = c);
  }
  /**
   * Imports course asset files
   * @return {Promise}
   */
  async importCourseAssets() {
    return Promise.allSettled(['images', 'video'].map(async folderName => {
      const files = await glob(`${this.unzipPath}/src/course/*/${folderName}/*`, { absolute: true });
      return Promise.allSettled(files.map(async f => {
        const mimetype = this.assets.utils.getMimeType(f);
        const title = path.basename(f);
        const description = title;
        const asset = await this.assets.import({ mimetype, filepath: f }, { title, description, createdBy: this.userId });
        // store the asset _id so we can map it to the old path later
        this.assetMap[path.relative(`${this.unzipPath}/src`, f)] = asset._id.toString();
      }));
    }));
  }
  /**
   * Imports course content plugins
   * @return {Promise}
   */
  async importCoursePlugins() {
    this.installedPlugins = (await this.contentplugin.find()).reduce((m,p) => Object.assign(m, { [p.name]: p }), {});
    const pluginsToInstall = {};

    Object.keys(this.usedContentPlugins).forEach(p => {
      const installedP = this.installedPlugins[p];
      const { version: importVersion } = this.usedContentPlugins[p];
      if(!installedP) {
        return pluginsToInstall[p] = { importVersion };
      }
      const { version: installedVersion } = installedP;
      if(this.settings.updatePlugins && semver.gt(importVersion, installedVersion)) {
        pluginsToInstall[p] = { importVersion, installedVersion };
      }
    });
    const pluginNamesToInstall = Object.keys(pluginsToInstall);
    
    if(pluginNamesToInstall.length) {
      if(!this.settings.importPlugins) {
        throw App.instance.errors.MISSING_PLUGINS
          .setData({ plugins: pluginNamesToInstall.join(', ') });
      }
      const errors = [];
      await Promise.all(pluginNamesToInstall.map(async p => {
        try {
          this.newContentPlugins[p] = await this.contentplugin.manualInstallPlugin(this.usedContentPlugins[p].path, { isZip: false });
        } catch(e) {
          if(e.code !== 'EEXIST') {
            this.framework.log('warn', `failed to import framework plugin, ${e}`);
            errors.push({ plugin: p, error: e });
          }
        }
      }));
      if(errors.length) {
        throw App.instance.errors.IMPORT_PLUGINS_FAILED
          .setData({ errors: errors.map(e => e.plugin).join(', ') });
      }
    }
    this.componentNameMap = Object.values({ ...this.installedPlugins, ...this.newContentPlugins }).reduce((m,v) => {
      return { ...m, [v.targetAttribute.slice(1)]: v.name };
    }, {});
  }
  /**
   * Imports all course content data
   * @return {Promise}
   */
  async importCourseData() {
    /**
     * Note: the execution order is important here
     * - config requires course to exist
     * - Defaults cannot be applied until the config exists
     * - Everything else requires course + config to exist
     */
    let course = await this.importContentObject(this.contentJson.course);
    let config = await this.importContentObject(this.contentJson.config);

    course = await this.applyDefaults(course);
    config = await this.applyDefaults(config);

    const cos = Object.values(this.contentJson.contentObjects);
    const siblingIds = [];
    const siblingData = [];
    
    await Promise.all(cos.map(async data => {
      const c = await this.importContentObject(data);
      const _parentId = c._parentId?.toString();
      if(_parentId && !siblingIds.includes(_parentId)) {
        siblingIds.push(_parentId);
        siblingData.push(c);
      }
    }));
    /**
     * Update the sortOrder values using the condensed list stored above
     * enabledPlugins only needs setting once for course
     */
    await Promise.all(siblingData.map(async c => await this.content.updateSortOrder(c)));
    await this.content.updateEnabledPlugins(course);
  }
  /**
   * Special-case function which applies defaults to an existing content item (required for course/config)
   * @param {Object} data The MongoDB document
   * @return {Promise} Resolves with the MongoDB document
   */
  async applyDefaults(data) {
    const [jsonschema, mongodb] = await App.instance.waitForModule('jsonschema', 'mongodb');
    const schema = await this.content.getSchema(data._type, data._type === 'course' ? data._id : data._courseId);
    const defaults = await jsonschema.validate(schema, {}, { useDefaults: true, ignoreRequired: true });

    return mongodb.replace(this.content.collectionName, { _id: data._id }, _.merge(defaults, data));
  }
  /**
   * Imports a single content object
   * @return {Object} The data to be imported
   * @return {Promise} Resolves with the created document
   */
  async importContentObject(data) {
    if(this.hasErrored) {
      return;
    }
    if(data._parentId) {
      if(!this.idMap[data._parentId]) { // parent hasn't been created yet, so wait until it has
        return new Promise((resolve, reject) => this.once(`insert:${data._parentId}`, () => this.importContentObject(data).then(resolve, reject)));
      }
    }
    const schemaName = AdaptFrameworkImport.typeToSchema(data);
    
    try {
      const jsonschema = await App.instance.waitForModule('jsonschema');
      const schema = await jsonschema.getSchema(schemaName);
      this.extractAssetsRecursive(schema.properties, data);
    } catch(e) {
      this.framework.log('error', e);
    }
    const insertData = this.transformData({
      ...data,
      _id: undefined,
      _courseId: this.idMap.course,
      _friendlyId: data._id,
      createdBy: this.userId
    });
    let doc = await this.content.insert(insertData, { schemaName, updateSortOrder: false, updateEnabledPlugins: false });
    this.idMap[data._id] = doc._id.toString();
    if(doc._type === 'course') {
      doc = await this.content.update({ _id: doc._id }, { _courseId: doc._id }, { emitEvent: false, validate: false });
    }
    this.emit(`insert:${data._id}`);
    return doc;
  }
  /**
   * Makes sure import data conforms prior to validation
   * @param {Object} data Data to transform
   * @return {Object} The transformed data
   */
  transformData(data) { 
    if(data._parentId) {
      data._parentId = this.idMap[data._parentId];
    }   
    if(data._type === 'component') {
      data._component = this.componentNameMap[data._component];
    }
    if(data._component === 'graphic' && data._graphic.src) {
      data._graphic.large = data._graphic.small = data._graphic.src;
    }
    return data;
  }
  /**
   * Infers the presence of any assets in incoming JSON data
   * @param {Object} schema Schema for the passed data
   * @param {Object} data Data to check
   */
  extractAssetsRecursive(schema, data) {
    Object.entries(schema).forEach(([key,val]) => {
      if(data[key] === undefined) {
        return;
      }
      if(val.properties) {
        this.extractAssetsRecursive(val.properties, data[key]);
      } else if(val?.items?.properties) {
        data[key].forEach(d => this.extractAssetsRecursive(val.items.properties, d));
      } else if(val?._backboneForms?.type === "Asset" || val?._backboneForms === "Asset") {
        data[key] = this.assetMap[data[key]];
      }
    });
  }
  /**
   * Performs necessary clean-up tasks
   * @param {Error|Boolean} error If param is truthy, extra error-related clean-up tasks are performed
   * @return {Promise}
   */
  async cleanUp(error) {
    try {
      const tasks = [
        fs.remove(this.unzipPath)
      ];
      if(error) {
        const { ObjectId } = await App.instance.waitForModule('mongodb');
        const _courseId = ObjectId.parse(this.idMap[this.contentJson.course._id]);
        tasks.push(
          this.content.deleteMany({ _courseId }),
          this.courseassets.deleteMany({ _courseId }),
          Promise.all(Object.values(this.newContentPlugins).map(p => this.contentplugin.uninstallPlugin(p._id))),
          Promise.all(Object.values(this.assetMap).map(a => this.assets.delete({ _id: a })))
        );
      }
      await Promise.all(tasks);
    } catch(e) {} // ignore any thrown errors
  }
}

export default AdaptFrameworkImport;