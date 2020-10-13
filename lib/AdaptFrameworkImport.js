const _ = require('lodash');
const { App, Events } = require('adapt-authoring-core');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');

const glob = promisify(require('glob'));
/**
 * Handles the Adapt framework import process
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
      Object.assign(this, {
        name: course.name,
        unzipPath: course.unzipPath.replace(/\\/g, '/'),
        contentJson: {
          course: {},
          contentObjects: []
        },
        idMap: {},
        userId: req.auth.user._id.toString()
      });
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
      await this.prepare();
      await this.loadCourseData();
      await this.importCourseAssets();
      await this.importCoursePlugins();
      await this.importCourseData();
    } catch(e) {
      error = e;
    }
    await this.cleanUp();
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
    const [content, contentplugin, framework] = await App.instance.waitForModule('content', 'contentplugin', 'adaptFramework');
    try {
      this.pkg = await fs.readJson(`${this.unzipPath}/package.json`);
    } catch(e) {
      throw createError('invalid import provided', 400);
    }
    if(!semver.satisfies(this.pkg.version, semver.major(framework.version).toString())) {
      throw new Error(`import framework (${this.pkg.version}) is incompatible with the installed framework (${this.framework.version})`);
    }
    this.content = content;
    this.contentplugin = contentplugin;
    this.framework = framework;
  }
  /**
   * Loads and caches all course content
   * @return {Promise}
   */
  async loadCourseData() {
    const installedPlugins = await glob(`${this.unzipPath}/src/+(components|extensions|menu|theme)/*`, { absolute: true });
    this.contentPlugins = installedPlugins.reduce((m, p) => Object.assign(m, { [p.split('/').pop()]: p }), {});

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
        _enabledPlugins: Object.keys(this.contentPlugins),
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
    return Promise.resolve();
  }
  /**
   * Imports course content plugins
   * @return {Promise}
   */
  async importCoursePlugins() {
    const results = await Promise.allSettled(Object.values(this.contentPlugins).map(d => {
      return this.contentplugin.manualInstallPlugin(d, { isZip: false });
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

    const coData = await Promise.all(Object.values(this.contentJson.contentObjects).map(c => this.importContentObject(c)));
    this.content.emit('insert', [course, config, ...coData]);
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
      friendlyId: data._id,
      createdBy: this.userId
    };
    if(!insertData._courseId) { /** @todo see issue #295 */
      delete insertData._courseId;
    }
    const doc = await this.content.insert(insertData, {
      schemaName: AdaptFrameworkImport.typeToSchema(data._type),
      emitEvent: false,
      validate: true
    });
    this.idMap[data._id] = doc._id.toString();
    this.emit(`insert:${data._id}`);
    return doc;
  }
  /**
   * Performs necessary clean-up tasks
   * @return {Promise}
   */
  async cleanUp() {
    try {
      await Promise.all([
        fs.remove(this.unzipPath),
        this.content.delete({ _id: this.idMap[this.contentJson.course._id] })
      ]);
    } catch(e) {
      throw createError(`Import clean up failed, ${e}`);
    }
  }
}
/** @ignore */
function createError(message, statusCode) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

module.exports = AdaptFrameworkImport;
