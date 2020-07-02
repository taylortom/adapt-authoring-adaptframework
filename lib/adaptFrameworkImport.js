const { App, Events } = require('adapt-authoring-core');
const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
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
  async prepare() {
    this.unzipPath = `${this.zipPath}_unzip`;
    await zipper.unzip(this.zipPath, this.unzipPath);

    await this.checkFolderStructure();
    try {
      this.version = (await fs.readJson(`${this.unzipPath}/package.json`)).version;
    } catch(e) {
      throw createError('invalid import provided', 400);
    }
    this.content = await App.instance.waitForModule('adapt-authoring-content');
    this.installedPlugins = (await glob(`${this.unzipPath}/src/+(components|extensions|menu|theme)/*`)).map(p => path.basename(p));
  }
  async checkFolderStructure() {
    try {
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
    } catch {}
  }
  async loadCourseData() {
    const files = await glob(`${this.unzipPath}/src/course/**/*.json`);
    return Promise.all(files.map(f => this.loadCourseFile(f)));
  }
  async loadCourseFile(filePath) {
    const contents = await fs.readJson(filePath);
    if(contents._type === 'course') {
      this.contentJson.course = contents;
      return;
    } else if(path.basename(filePath) === 'config.json') {
      this.contentJson.contentObjects.config = {
        _id: 'config',
        _type: 'config',
        _enabledPlugins: this.installedPlugins,
        ...contents
      };
      return;
    }
    contents.forEach(c => this.contentJson.contentObjects[c._id] = c);
  }
  async verifyCourse() {
    // TODO should check what's being imported is compatible with this install
    return Promise.resolve();
  }
  async importCourseAssets() {
    return Promise.resolve();
  }
  async importCoursePlugins() {
    return Promise.resolve();
  }
  async importCourseData() {
    await this.importContentObject(this.contentJson.course);
    return Promise.all(Object.values(this.contentJson.contentObjects).map(c => this.importContentObject(c)));
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
      friendlyId: data._id,
      _courseId: this.idMap.course,
      createdAt: new Date().toISOString(),
      createdBy: this.userId,
      updatedAt: new Date().toISOString()
    };
    const doc = await this.content.insert(insertData, { schemaName: AdaptFrameworkImport.typeToSchema(data._type) });
    this.idMap[data._id] = doc._id.toString();
    this.emit(`insert:${data._id}`);
  }
  async import() {
    let error;
    try {
      await this.prepare();
      await this.loadCourseData();
      await this.verifyCourse();
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
