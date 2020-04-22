const _ = require('lodash');
const { App, Events } = require('adapt-authoring-core');
const fs = require('fs-extra');
const path = require('path');
const { promisify } = require('util');
const zipper = require('zipper');

const glob = promisify(require('glob'));

class AdaptFrameworkImport extends Events {
  /**
  * Imports a course zip to the database
  * @return {Promise}
  */
  static async run(data) {
     return new AdaptFrameworkImport(data).import();
  }
  constructor(req) {
    super();
    try {
      const course = req.fileUpload.files.course;

      if(!course || !course.name || !course.path) {
        throw new Error();
      }
      Object.assign(this, {
        name: course.name,
        zipPath: course.path.replace(/\\/g, '/'),
        contentJson: {
          course: {},
          contentObjects: []
        },
        idMap: {}
      });
    } catch(e) {
      throw createError('invalid course data provided', 400);
    }
  }
  async prepare() {
    this.unzipPath = `${this.zipPath}_unzip`;
    await zipper.unzip(this.zipPath, this.unzipPath);
    try {
      this.version = (await fs.readJson(`${this.unzipPath}/package.json`)).version;
    } catch(e) {
      throw createError('invalid import provided', 400);
    }
    this.content = await App.instance.waitForModule('adapt-authoring-content');
  }
  async loadCourseData() {
    const files = await glob(`${this.unzipPath}/src/course/**/*.json`);
    return Promise.all(files.map(f => this.loadCourseFile(f)));
  }
  async loadCourseFile(filePath) {
    let contents = await fs.readJson(filePath);
    if(contents._type === 'course') {
      this.contentJson.course = contents;
      return;
    } else if(path.basename(filePath) === 'config.json') {
      this.contentJson.contentObjects.config = {
        _id: 'config',
        _type: 'config',
        ...contents
      };
      return;
    }
    contents.forEach(c => this.contentJson.contentObjects[c._id] = c);
  }
  async importCourseData() {
    await this.importContentObject(this.contentJson.course);
    return Promise.all(Object.values(this.contentJson.contentObjects).map(c => this.importContentObject(c)));
  }
  async importContentObject(data) {
    if(data._parentId) {
      if(!this.idMap[data._id]) {
        return this.once(`insert:${data._parentId}`, () => this.importContentObject(data));
      }
      data._parentId = this.idMap[data._id];
    }
    console.log('AdaptFrameworkImport#importContentObject:', data._type, data._id, `(${data._parentId})`);
    const extras = {
      _id: undefined,
      createdAt: new Date().toISOString(),
      createdBy: 'xxxxxxxxxxxx',
      updatedAt: new Date().toISOString()
    };
    const doc = await this.content.insert({ ...data, ...extras }, { schemaName: data._type });
    this.emit(`insert:${data._id}`, doc);
  }
  async import() {
    await this.prepare();
    await this.loadCourseData();
    await this.importCourseData();
    // await this.cleanUp();
    return this;
  }
  async cleanUp() {
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
