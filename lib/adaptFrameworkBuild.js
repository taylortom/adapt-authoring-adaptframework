const { App, Events } = require('adapt-authoring-core');
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
    return new AdaptFrameworkBuild(req).buildCourse();
  }
  /**
  * Returns a timestring to be used for an adaptbuild expiry
  * @return {String}
  */
  static async getBuildExpiry() {
    const config = await App.instance.get('config');
    const [ amount, unit ] = config.get('adapt-authoring-adaptFramework.buildLifespan').split(' ');
    return moment().add(amount, unit).toISOString();
  }
  /**
  * @constructor
  * @param {ClientRequest} req
  */
  constructor(req) {
    super();
    Object.assign(this, {
      action: req.action,
      isPreview: req.action === 'preview',
      isPublish: req.action === 'publish',
      isExport: req.action === 'export',
      courseId: req.params.id,
      buildCache: {},
      buildOptions: {
        mode: 'prod',
        menu: 'adapt-contrib-boxMenu',
        theme: 'adapt-contrib-vanilla'
      },
      userId: req.auth.user._id.toString()
    });
  }
  /**
  * Performs a specified build action on single course
  * @param {String}  courseId ID of course being built
  * @param {String} action Build action to be performed
  * @param {String} userId User making the build attempt
  * @return {Promise} Resolves with build attempt metadata
  */
  async performCourseAction() {
    const dir = await this.buildCourse();
    const location = this.isPreview ? await this.createPreview(dir) : await this.createZip(dir);
    return this.recordBuildAttempt(location);
  }
  async createPreview(buildDir) {
    const tempName = `${buildDir}_temp`;
    await fs.move(path.join(buildDir, 'build'), tempName);
    await fs.remove(buildDir);
    await fs.move(tempName, buildDir);
    return buildDir;
  }
  async createZip(buildDir) {
    const zipPath = path.join(buildDir, this.isPublish ? 'build' : '');
    const outputPath = `${buildDir}.zip`;
    await zipper.zip(zipPath, outputPath, { removeSource: true });
    return outputPath;
  }
  async loadCourseData() {
    this.courseDir = path.join(this.dir, 'src', 'course');
    const langDir = path.join(this.courseDir, 'en');

    const [content, mongodb] = await App.instance.waitForModule('content', 'mongodb');
    const [course] = await content.find({ _id: this.courseId });

    this.courseData = {
      course: { dir: langDir, fileName: 'course.json', data: course },
      config: { dir: this.courseDir, fileName: 'config.json', data: undefined },
      contentObject: { dir: langDir, fileName: 'contentObjects.json', data: [] },
      article: { dir: langDir, fileName: 'articles.json', data: [] },
      block: { dir: langDir, fileName: 'blocks.json', data: [] },
      component: { dir: langDir, fileName: 'components.json', data: [] }
    };
    this.groupContentItems(await content.find({ _courseId: mongodb.ObjectId.parse(course._id) }));
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
    return fs.copy(fwPath, this.dir, {
      filter: () => true
    });
  }
  async writeContentJson() {
    return Promise.all(Object.values(this.courseData).map(({ dir, fileName, data }) => {
      return fs.writeJson(path.join(dir, fileName), data, 2);
    }));
  }
  /**
  * Runs the Adapt framework build tools to generate a course build
  * @return {Promise} Resolves with the output directory
  */
  async buildCourse() {
    this.dir = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());
    await fs.ensureDir(this.dir);
    await this.loadCourseData();

    await Promise.all([
      this.copySource(),
      this.writeContentJson()
      /** @todo copy assets */
    ]);
    const { mode, menu, theme } = this.buildOptions;
    return new Promise((resolve, reject) => {
      exec(`grunt server-build:${mode} --theme=${theme} --menu=${menu}`, { cwd: this.dir }, (error, stdout, stderr) => {
        if(error || stderr.length) return reject(error || stderr);
        resolve(this.dir);
      });
    });
  }
  /**
  * Stored metadata about a build attempt in the DB
  * @param {String} courseId
  * @param {String} action
  * @param {String} userId
  * @param {String} location
  * @return {Promise} Resolves with the DB document
  */
  async recordBuildAttempt(location) {
    const mdb = await App.instance.waitForModule('mongodb');
    return mdb.insert('adaptbuilds', {
      action: this.action,
      courseId: this.courseId,
      location: location,
      expiresAt: await AdaptFrameworkBuild.getBuildExpiry(),
      createdBy: this.userId
    });
  }
}

module.exports = AdaptFrameworkBuild;
