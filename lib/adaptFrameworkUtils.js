const { App, Utils } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');

const FrameworkBuild = require('./adaptFrameworkBuild');
const FrameworkImport = require('./adaptFrameworkImport');

const buildCache = {};
/**
* Utilities for use with the AdaptFrameworkModule
*/
class AdaptFrameworkUtils {
  /**
  * Copies and initialises Adapt framework files
  * @param {String} cwd Directory to create framework copy
  * @return {Promise}
  */
  static async createLocalFramework(cwd) {
    await fs.copy(Utils.getModuleDir('adapt_framework'), cwd);

    const binPath = path.join(App.instance.getConfig('root_dir'), 'node_modules', 'adapt-cli', 'bin', 'adapt');

    AdaptFrameworkUtils.runShellTask(`npm install`, { cwd });
    return AdaptFrameworkUtils.runShellTask(`${binPath} install`, { cwd });
  }
  /**
  * Runs a new shell command
  * @param {String} command Command to run
  * @param {Object} options Options to be passed to child_process.exec
  * @return {Promise}
  * @see https://nodejs.org/api/child_process.html#child_process_child_process_exec_command_options_callback
  */
  static async runShellTask(command, options) {
    return new Promise((resolve, reject) => {
      exec(`${command}`, options, (error, stdout, stderr) => {
        if(error || stderr.length) return reject(error || stderr);
        resolve();
      });
    });
  }
  /**
  * Infers the framework action to be executed from a given request URL
  * @param {ClientRequest} req
  * @return {String}
  */
  static inferBuildAction(req) {
    return req.url.slice(1, req.url.indexOf('/', 1));
  }
  /**
  * Retrieves metadata for a build attempt
  * @param {String} id ID of build document
  * @return {Promise}
  */
  static async retrieveBuildData(id) {
    if(buildCache[id]) {
      return buildCache[id];
    }
    const mdb = await App.instance.waitForModule('mongodb');
    try {
      const [data] = await mdb.find('adaptbuilds', { _id: id });
      buildCache[id] = data;
      return data;
    } catch(e) {
      throw new Error(`Error retrieving build data, '${e.message}'`);
    }
  }
  /**
  * Handles POST requests to the API
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  * @return {Promise}
  */
  static async postHandler(req, res, next) {
    const adaptFramework = await App.instance.waitForModule('adaptFramework');
    const action = AdaptFrameworkUtils.inferBuildAction(req);

    req.action = action;

    adaptFramework.log('info', `running ${action} for course '${req.params.id}'`);
    try {
      const { isPreview, buildData } = await FrameworkBuild.run(req);
      adaptFramework.log('info', `finished ${action} for course '${req.params.id}'`);
      const urlRoot = isPreview ? adaptFramework.rootRouter.url : adaptFramework.apiRouter.url;
      res.json({ [`${action}_url`]: `${urlRoot}/${action}/${buildData._id}/` });
    } catch(e) {
      adaptFramework.log('error', `failed to ${action} course '${req.params.id}'`);
      next(e);
    }
  }
  /**
  * Handles POST /import requests to the API
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  * @return {Promise}
  */
  static async importHandler(req, res, next) {
    const adaptFramework = await App.instance.waitForModule('adaptFramework');
    adaptFramework.log('info', `running course import`);

    try {
      const { name, version, unzipPath } = await FrameworkImport.run(req);
      res.json({ name, version, unzipPath });

    } catch(e) {
      adaptFramework.log('error', `failed to import course, ${e}`);
      next(e);
    }
  }
  /**
  * Handles GET requests to the API
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  * @return {Promise}
  */
  static async getHandler(req, res, next) {
    const action = AdaptFrameworkUtils.inferBuildAction(req);
    const id = req.params.id;
    let buildData, filePath;
    try {
      buildData = await AdaptFrameworkUtils.retrieveBuildData(id);
    } catch(e) {
      return next(e);
    }
    if(!buildData) {
      return res.sendError(res.StatusCodes.Error.Missing, `No build found matching _id '${id}'. Check it is valid, and has not expired.`);
    }
    switch(action) {
      case 'preview':
        filePath = path.join(buildData.location, req.path.slice(req.path.indexOf(id)+id.length+1) || 'index.html');
        break;
      case 'publish':
      case 'export':
        filePath = buildData.location;
        res.set('content-disposition', `attachment; filename="adapt-${action}-${buildData._id}.zip"`);
    }
    res.sendFile(filePath);
  }
}

module.exports = AdaptFrameworkUtils;
