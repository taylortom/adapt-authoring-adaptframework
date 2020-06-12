const { App, Events } = require('adapt-authoring-core');
const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');
const zipper = require('zipper');

const FWUtils = require('./adaptFrameworkUtils');

class AdaptFrameworkBuild extends Events {
  /**
  * Imports a course zip to the database
  * @param {ClientRequest} req
  * @return {Promise}
  */
  static async run(req) {
    return new AdaptFrameworkBuild(req).build();
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
    const action = FWUtils.inferBuildAction(req);
    Object.assign(this, {
      action,
      isPreview: action === 'preview',
      isPublish: action === 'publish',
      isExport: action === 'export',
      courseId: 'xxxxxxxxxx',
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
  /**
  * Runs the Adapt framework build tools to generate a course build
  * @return {Promise} Resolves with the output directory
  */
  async buildCourse() {
    const cwd = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());
    const { mode, menu, theme } = this.buildOptions;

    await fs.ensureDir(cwd);
    await fs.copy((await App.instance.waitForModule('adaptFramework')).framework_dir, cwd);
    await FWUtils.runShellTask(`grunt server-build:${mode} --theme=${theme} --menu=${menu}`, { cwd });

    return cwd;
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
