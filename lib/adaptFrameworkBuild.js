const { App, Events } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');
const zipper = require('zipper');

class AdaptFrameworkBuild extends Events {
  /**
  * Imports a course zip to the database
  * @param {ClientRequest} req
  * @return {Promise}
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
    const dir = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());
    Object.assign(this, {
      action: req.action,
      isPreview: req.action === 'preview',
      isPublish: req.action === 'publish',
      isExport: req.action === 'export',
      courseId: req.params.id,
      buildData: {},
      userId: req.auth.user._id.toString(),
      dir: dir,
      courseDir: path.join(dir, 'src', 'course'),
      disabledPlugins: []
    });
  }
  /**
  * Runs the Adapt framework build tools to generate a course build
  * @return {Promise} Resolves with the output directory
  */
  async build() {
    await fs.ensureDir(this.dir);
    await this.loadCourseData();

    await Promise.all([
      this.copySource(),
      this.copyAssets(),
      this.writeContentJson()
    ]);
    if(!this.isExport) {
      await this.execGrunt();
    }
    this.isPreview ? await this.createPreview() : await this.createZip();
    this.buildData = await this.recordBuildAttempt();
  }
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
      course: { dir: langDir, fileName: 'course.json', data: course },
      config: { dir: this.courseDir, fileName: 'config.json', data: undefined },
      contentObject: { dir: langDir, fileName: 'contentObjects.json', data: [] },
      article: { dir: langDir, fileName: 'articles.json', data: [] },
      block: { dir: langDir, fileName: 'blocks.json', data: [] },
      component: { dir: langDir, fileName: 'components.json', data: [] }
    };
    this.groupContentItems(await content.find({ _courseId: mongodb.ObjectId.parse(course._id) }));
    await this.determineDisabledPlugins();
  }
  async determineDisabledPlugins() {
    const mongodb = await App.instance.waitForModule('mongodb');
    const all = await mongodb.find('contentplugins');
    const enabled = this.courseData.config.data._enabledPlugins || [];
    all.forEach(({name}) => !enabled.includes(name) && this.disabledPlugins.push(name));
  }
  groupContentItems(contentItems) {
    contentItems.forEach(c => {
      if(c._type === 'config') {
        this.courseData.config.data = c;
      } else if(c._type === 'menu' || c._type === 'page') {
        this.courseData.contentObject.data.push(c);
      } else {
        this.courseData[c._type].data.push(c);
      }
    });
  }
  async copySource() {
    const { path: fwPath } = await App.instance.waitForModule('adaptFramework');
    const blacklist = ['.DS_Store','node_modules','course', ...this.disabledPlugins];
    await fs.copy(fwPath, this.dir, { filter: f => !blacklist.includes(path.basename(f)) });
    if(!this.isExport) {
      await fs.symlink(path.join(fwPath, 'node_modules'), path.join(this.dir, 'node_modules'));
    }
  }
  async copyAssets() {
    /** @todo */
  }
  async writeContentJson() {
    return Promise.all(Object.values(this.courseData).map(async ({ dir, fileName, data }) => {
      await fs.ensureDir(dir);
      return fs.writeJson(path.join(dir, fileName), data, { spaces: 2 });
    }));
  }
  async createPreview() {
    const tempName = `${this.dir}_temp`;
    await fs.move(path.join(this.dir, 'build'), tempName);
    await fs.remove(this.dir);
    await fs.move(tempName, this.dir);
    this.location = this.dir;
  }
  async createZip() {
    if(!this.isExport) {
      await fs.unlink(path.join(this.dir, 'node_modules'));
    }
    const zipPath = path.join(this.dir, this.isPublish ? 'build' : '');
    const outputPath = `${this.dir}.zip`;
    await zipper.zip(zipPath, outputPath, { removeSource: true });
    await fs.remove(this.dir);
    this.location = outputPath;
  }
  async execGrunt() {
    return new Promise((resolve, reject) => {
      const { _menu, _theme, _generateSourcemap } = this.courseData.config.data;
      const mode = _generateSourcemap ? 'dev' : 'prod';
      exec(`grunt server-build:${mode} --theme=${_theme} --menu=${_menu}`, { cwd: this.dir }, (error, stdout, stderr) => {
        error || stderr.length ? reject(error || stderr) : resolve();
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
