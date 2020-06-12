const { App, Events } = require('adapt-authoring-core');
const moment = require('moment');

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
    const [ amount, unit ] = config.get('adapt-authoring-adaptFramework.buildExpiry').split(' ');
    return moment().add(amount, unit).toISOString();
  }
  /**
  * @constructor
  * @param {ClientRequest} req
  */
  constructor(req) {
    super();
    Object.assign(this, {
      userId: req.auth.user._id.toString()
    });
  }

  async build() {
    // @todo
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
}

module.exports = AdaptFrameworkBuild;
