const { App, Events } = require('adapt-authoring-core');
const fs = require('fs-extra');
const moment = require('moment');
const path = require('path');

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
    Object.assign(this, {
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
  * Runs the Adapt framework build tools to generate a course build
  * @return {Promise} Resolves with the output directory
  */
  async build() {
    const cwd = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());
    const { mode, menu, theme } = this.buildOptions;

    await fs.ensureDir(cwd);
    await fs.copy((await App.instance.waitForModule('adaptFramework')).framework_dir, cwd);
    await FWUtils.runShellTask(`grunt server-build:${mode} --theme=${theme} --menu=${menu}`, { cwd });

    return { dir };
  }
  /**
  * Stored metadata about a build attempt in the DB
  * @param {String} courseId
  * @param {String} action
  * @param {String} userId
  * @param {String} location
  * @return {Promise} Resolves with the DB document
  */
  async recordBuildAttempt(courseId, action, userId, location) {
    const mdb = await App.instance.waitForModule('mongodb');
    return mdb.insert('adaptbuilds', {
      action: action,
      courseId: courseId,
      location: location,
      expiresAt: await this.getBuildExpiry(),
      createdBy: userId
    });
  }
  /**
  * Retrieves metadata for a build attempt
  * @param {String} id ID of build document
  * @return {Promise}
  */
  async retrieveBuildData(id) {
    if(this.buildCache[id]) {
      return this.buildCache[id];
    }
    const mdb = await App.instance.waitForModule('mongodb');
    let data;
    try {
      data = await mdb.find('adaptbuilds', { _id: id });
    } catch(e) {
      throw new Error(`Error retrieving build data, '${e.message}'`);
    }
    if(data.length === 1) {
      this.buildCache[id] = data[0];
      return data[0];
    }
  }
}

module.exports = AdaptFrameworkBuild;
