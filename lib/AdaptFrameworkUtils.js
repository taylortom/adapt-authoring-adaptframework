const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { unzip } = require('zipper');

const { App, Utils } = require('adapt-authoring-core');

const FrameworkBuild = require('./AdaptFrameworkBuild');
const FrameworkImport = require('./AdaptFrameworkImport');

/** @ignore */ const buildCache = {};

let fw;
/**
 * Logs a message using the framework module
 * @param {...*} args Arguments to be logged
 */
async function log(...args) {
  if(!fw) fw = await App.instance.waitForModule('adaptFramework');
  fw.log(...args);
}
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

    log('info', `running ${action} for course '${req.params.id}'`);
    try {
      const { isPreview, buildData } = await FrameworkBuild.run(req);
      log('info', `finished ${action} for course '${req.params.id}'`);
      const urlRoot = isPreview ? adaptFramework.rootRouter.url : adaptFramework.apiRouter.url;
      res.json({ [`${action}_url`]: `${urlRoot}/${action}/${buildData._id}/` });
    } catch(e) {
      log('error', `failed to ${action} course '${req.params.id}'`);
      return next(e);
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
    try {
      log('info', `running course import`);

      await AdaptFrameworkUtils.handleImportFile(req, res);

      const data = await FrameworkImport.run(req);
      res.json({ courseId: data.idMap.course });

    } catch(e) {
      log('error', `failed to import course, ${e}`);
      return next(e);
    }
  }
  /**
   * Deals with an incoming course (supports both local zip and remote URL stream)
   * @param {ClientRequest} req
   * @param {ServerResponse} res
   * @return {Promise}
   */
  static async handleImportFile(req, res) {
    if(req.get('Content-Type').indexOf('multipart/form-data') === 0) {
      const middleware = await App.instance.waitForModule('middleware');
      return new Promise((resolve, reject) => {
        middleware.fileUploadParser('application/zip', { unzip: true })(req, res, e => e ? reject(e) : resolve());
      });
    }
    if(req.body.url) {
      let responseData;
      try {
        responseData = (await axios.get(req.body.url, { responseType: 'stream' })).data;
      } catch(e) {
        const is404 = e.response.status === 404;
        res.status(e.response.status).json({ message: is404 ? 'Remote file not found' : e.response.data });
        return;
      }
      const outputDir = App.instance.getConfig('uploadTempDir');
      const time = new Date().getTime();
      const courseData = {
        name: `${time}.zip`,
        path: `${outputDir}/${time}`,
        type: 'application/zip'
      };
      return new Promise(async (resolve, reject) => {
        await fs.ensureDir(outputDir);
        responseData.pipe(fs.createWriteStream(courseData.path)).on('close', async () => {
          req.fileUpload = { files: { course: courseData } };
          req.fileUpload.files.course.unzipPath = await unzip(courseData.path, `${courseData.path}_unzip`);
          resolve();
        }).on('error', reject);
      });
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
    let buildData;
    try {
      buildData = await AdaptFrameworkUtils.retrieveBuildData(id);
    } catch(e) {
      return next(e);
    }
    if(!buildData || new Date(buildData.expiresAt).getTime() < Date.now()) {
      const e = new Error(`No build found matching _id '${id}'. Check it is valid, and has not expired.`);
      e.statusCode = 404;
      return next(e);
    }
    if(action === 'publish' || action === 'export') {
      res.set('content-disposition', `attachment; filename="adapt-${action}-${buildData._id}.zip"`);
      try {
        return res.sendFile(path.resolve(buildData.location));
      } catch(e) {
        return next(e);
      }
    }
    if(action === 'preview') {
      const filePath = path.resolve(buildData.location, req.path.slice(req.path.indexOf(id)+id.length+1) || 'index.html');
      try {
        await fs.stat(filePath);
        res.sendFile(filePath);
      } catch(e) {
        e.statusCode = e.code === 'ENOENT' ? 404 : 500;
        return next(e);
      }
    }
  }
}

module.exports = AdaptFrameworkUtils;
