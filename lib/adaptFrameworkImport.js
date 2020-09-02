const { App, Events } = require('adapt-authoring-core');
const { promisify } = require('util');
const fs = require('fs-extra');
const path = require('path');
const semver = require('semver');
const zipper = require('zipper');

const glob = promisify(require('glob'));

class AdaptFrameworkImport extends Events {
  /**
  * Imports a course zip to the database
  * @param {ClientRequest} req
  * @return {Promise}
  */
  static async run(req) {
    return new AdaptFrameworkImport(req).import();
  }
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

      if(!course || !course.name || !course.path || course.type !== 'application/zip') {
        throw new Error();
      }
      Object.assign(this, {
        name: course.name,
        zipPath: course.path.replace(/\\/g, '/'),
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
  async import() {
    let error;
    try {
      await this.unzip();
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
  async unzip() {
    this.unzipPath = `${this.zipPath}_unzip`;
    await zipper.unzip(this.zipPath, this.unzipPath);
    try { // if it's a nested zip, move everything up a level
      const files = await fs.readdir(this.unzipPath);
      if(files.length > 1) {
        return;
      }
      const nestDir = `${this.unzipPath}/${files[0]}`;
      await fs.stat(`${nestDir}/package.json`);
      const newDir = path.join(`${this.unzipPath}_2`);
      await fs.move(nestDir, newDir);
      await fs.remove(this.unzipPath);
      this.unzipPath = newDir;
    } catch(e) {}
  }
  async prepare() {
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
  async loadCourseData() {
    const installedPlugins = await glob(`${this.unzipPath}/src/+(components|extensions|menu|theme)/*`, { absolute: true });
    this.contentPlugins = installedPlugins.reduce((m, p) => Object.assign(m, { [p.split('/').pop()]: p }), {});

    const files = await glob(`${this.unzipPath}/src/course/**/*.json`);
    return Promise.all(files.map(f => this.loadContentFile(f)));
  }
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
  async importCourseAssets() {
    return Promise.resolve();
  }
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
  async importCourseData() {
    const course = await this.importContentObject(this.contentJson.course);
    const config = await this.importContentObject(this.contentJson.config);
    const coData = await Promise.all(Object.values(this.contentJson.contentObjects).map(c => this.importContentObject(c)));
    this.content.emit('insert', [course, config, ...coData]);
  }
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
    const doc = await this.content.insert(insertData, {
      schemaName: AdaptFrameworkImport.typeToSchema(data._type),
      emitEvent: false,
      validate: true
    });
    this.idMap[data._id] = doc._id.toString();
    this.emit(`insert:${data._id}`);
    return doc;
  }
  async cleanUp() {
    /**
    * TODO need to be able to handle failed/partial imports gracefully:
    * - Content: entire course should probably be deleted
    * - Assets: remove asset records + files
    * - Plugins: ?
    */
    try {
      Promise.all([
        fs.remove(this.zipPath),
        fs.remove(this.unzipPath)
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
