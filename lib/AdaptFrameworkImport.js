const _ = require('lodash');
const { App, Events } = require('adapt-authoring-core');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');

/** @ignore */const glob = promisify(require('glob'));
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
   * @param {String} type The content type
   * @return {String} The schema name
   */
  static typeToSchema(type) {
    switch(type) {
      case 'menu':
      case 'page':
        return 'contentobject';
      default:
        return type;
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

      if(!course || !course.name || !course.unzipPath) {
        throw new Error();
      }
      /**
       * The name of the import file being imported
       * @type {String}
       */
      this.name = course.name;
      /**
       * Reference to the package.json data
       * @type {Object}
       */
      this.pkg;
      /**
       * Path that the import will be unzipped to
       * @type {String}
       */
      this.unzipPath = course.unzipPath.replace(/\\/g, '/');
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
       * All plugins installed during the import as a name -> _id map
       * @type {Object}
       */
      this.newContentPlugins = {};
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

    } catch(e) {
      throw createError('invalid course data provided', 400);
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
      ] = await App.instance.waitForModule('assets', 'content', 'contentplugin', 'courseassets', 'adaptFramework');
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
      await this.importCourseAssets();
      await this.loadCourseData();
      await this.importCoursePlugins();
      await this.importCourseData();
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
      throw createError('invalid import provided', 400);
    }
    if(!semver.satisfies(this.pkg.version, semver.major(this.framework.version).toString())) {
      throw new Error(`import framework (${this.pkg.version}) is incompatible with the installed framework (${this.framework.version})`);
    }
  }
  /**
   * Loads and caches all course content
   * @return {Promise}
   */
  async loadCourseData() {
    const usedPluginPaths = await glob(`${this.unzipPath}/src/+(components|extensions|menu|theme)/*`, { absolute: true });
    /** @ignore */this.usedContentPlugins = usedPluginPaths.reduce((m, p) => Object.assign(m, { [p.split('/').pop()]: p }), {});
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
    contents.forEach(c => this.contentJson.contentObjects[c._id] = c);
  }
  /**
   * Imports course asset files
   * @return {Promise}
   */
  async importCourseAssets() {
    return Promise.allSettled(['images', 'video'].map(async folderName => {
      const files = await glob(`${this.unzipPath}/src/course/*/${folderName}/*`, { absolute: true });
      return Promise.allSettled(files.map(async f => {
        const type = this.assets.utils.getMimeType(f);
        const title = path.basename(f);
        const description = title;
        const asset = await this.assets.import({ type, path: f }, { title, description, createdBy: this.userId });
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
    const installedPlugins = (await this.contentplugin.find()).map(p => p.name);
    const pluginsToInstall = Object.keys(this.usedContentPlugins).filter(p => !installedPlugins.includes(p));
    const results = await Promise.allSettled(pluginsToInstall.map(async p => {
      const { _id } = await contentplugin.manualInstallPlugin(this.usedContentPlugins[p], { isZip: false });
      this.newContentPlugins[p] = _id;
    }));
    results.forEach(r => {
      if(r.status === 'rejected' && r.reason.code !== 'EEXIST') {
        this.framework.log('warn', `failed to import framework plugin, ${r.reason}`);
      }
    });
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

    return Promise.all(Object.values(this.contentJson.contentObjects).map(c => this.importContentObject(c)));
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
    // internal function to be called recursively
    const _extractAssetsRecursive = ((schema, data) => {
      Object.entries(schema).forEach(([key,val]) => {
        if(data[key] === undefined) {
          return;
        }
        if(val.properties) {
          _extractAssetsRecursive(val.properties, data[key]);
        } else if(val?.items?.properties) {
          data[key].forEach(d => _extractAssetsRecursive(val.items.properties, d));
        } else if(val?._backboneForms?.type === "Asset" || val?._backboneForms === "Asset") {
          data[key] = this.assetMap[data[key]];
        }
      });
    }).bind(this);
    const schemaName = AdaptFrameworkImport.typeToSchema(data._type);
    try {
      const jsonschema = await App.instance.waitForModule('jsonschema');
      const schema = await jsonschema.getSchema(schemaName);
      _extractAssetsRecursive(schema.properties, data);
    } catch(e) {
      this.framework.log('error', e);
    } 
    if(data._parentId) {
      if(!this.idMap[data._parentId]) {
        return new Promise((resolve, reject) => {
          this.once(`insert:${data._parentId}`, () => this.importContentObject(data).then(resolve, reject));
        });
      }
      data._parentId = this.idMap[data._parentId];
    }
    const insertData = {
      ...data,
      _id: undefined,
      _courseId: this.idMap.course,
      _friendlyId: data._id,
      createdBy: this.userId
    };
    if(!insertData._courseId) { /** @todo see issue #295 */
      delete insertData._courseId;
    }
    let doc = await this.content.insert(insertData, { schemaName });
    this.idMap[data._id] = doc._id.toString();
    if(doc._type === 'course') {
      doc = await this.content.update({ _id: doc._id }, { _courseId: doc._id }, { emitEvent: false, validate: false });
    }
    this.emit(`insert:${data._id}`);
    return doc;
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
          Promise.all(Object.values(this.newContentPlugins).map(p => this.contentplugin.uninstallPlugin(_id))),
          Promise.all(Object.values(this.assetMap).map(a => this.assets.delete({ _id: a })))
        );
      }
      await Promise.all(tasks);
    } catch(e) {} // ignore any thrown errors
  }
}
/** @ignore */
function createError(message, statusCode) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

module.exports = AdaptFrameworkImport;
