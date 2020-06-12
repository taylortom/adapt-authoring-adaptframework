const { App, Utils } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const Importer = require('./adaptFrameworkImport');
const path = require('path');
const zipper = require('zipper');
/**
* Utilities for use with the AdaptFrameworkModule
*/
class AdaptFrameworkUtils {
  /**
  * Copies and initialises Adapt framework files
  * @param {String} dir Directory to create framework copy
  * @return {Promise}
  */
  static async createLocalFramework(dir) {
    await fs.copy(Utils.getModuleDir('adapt_framework'), dir);

    const binPath = path.join(App.instance.getConfig('root_dir'), 'node_modules', 'adapt-cli', 'bin', 'adapt');
    await AdaptFrameworkUtils.runShellTask(`${binPath} install`, { cwd: dir });
  }
  /**
  * Performs a specified build action on single course
  * @param {String}  courseId ID of course being built
  * @param {String} action Build action to be performed
  * @param {String} userId User making the build attempt
  * @return {Promise} Resolves with build attempt metadata
  */
  static async performCourseAction(courseId, action, userId) {
    const isPreview = action === 'preview';
    const isPublish = action === 'publish';
    const isExport = action === 'export';

    const buildDir = (await AdaptFrameworkUtils.buildCourse(courseId)).dir;
    let location;

    if(isPreview) {
      const tempName = `${buildDir}_temp`;
      await fs.move(path.join(buildDir, 'build'), tempName);
      await fs.remove(buildDir);
      await fs.move(tempName, buildDir);
      location = buildDir;
    }
    if(isPublish || isExport) {
      const zipPath = path.join(buildDir, isPublish ? 'build' : '');
      const outputPath = `${buildDir}.zip`;
      await zipper.zip(zipPath, outputPath, { removeSource: true });
      location = outputPath;
    }
    const attemptData = await AdaptFrameworkUtils.recordBuildAttempt(courseId, action, userId, location);
    return attemptData;
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
  * Handles POST requests to the API
  * @param {ClientRequest} req
  * @param {ServerResponse} res
  * @param {Function} next
  * @return {Promise}
  */
  static async postHandler(req, res, next) {
    const adaptFramework = await App.instance.waitForModule('adaptFramework');
    const action = AdaptFrameworkUtils.inferAction(req);
    adaptFramework.log('info', `running ${action} for course '${req.params.id}'`);
    try {
      const data = await AdaptFrameworkUtils.performCourseAction(req.params.id, action, req.params.id);
      adaptFramework.log('info', `finished ${action} for course '${req.params.id}'`);
      const urlRoot = action === 'preview' ? adaptFramework.rootRouter.url : adaptFramework.apiRouter.url;
      res.json({ [`${action}_url`]: `${urlRoot}/${action}/${data._id}/` });
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
      const { name, version, unzipPath } = await Importer.run(req);
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
    const action = AdaptFrameworkUtils.inferAction(req);
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
  /**
  * Infers the framework action to be executed from a given request URL
  * @param {ClientRequest} req
  * @return {String}
  */
  static inferAction(req) {
    return req.url.slice(1, req.url.indexOf('/', 1));
  }
}

module.exports = AdaptFrameworkUtils;
