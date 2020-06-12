const { App, Events } = require('adapt-authoring-core');

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
}

module.exports = AdaptFrameworkBuild;
