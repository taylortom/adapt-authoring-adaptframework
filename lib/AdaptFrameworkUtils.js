import { App } from 'adapt-authoring-core';
import axios from 'axios';
import FrameworkBuild from './AdaptFrameworkBuild.js';
import FrameworkImport from './AdaptFrameworkImport.js';
import fs from 'fs';
import path from 'path';
import { unzip } from 'zipper';

/** @ignore */ const buildCache = {};

let fw;
/**
 * Logs a message using the framework module
 * @param {...*} args Arguments to be logged
 */
/** @ignore */
async function log(...args) {
  if(!fw) fw = await App.instance.waitForModule('adaptframework');
  fw.log(...args);
}
/**
 * Utilities for use with the AdaptFrameworkModule
 */
class AdaptFrameworkUtils {
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
      throw App.instance.errors.BUILD_DATA_RETRIEVAL_FAILED
        .setData({ error: e.message });
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
    const framework = await App.instance.waitForModule('adaptframework');
    const action = AdaptFrameworkUtils.inferBuildAction(req);
    const courseId = req.params.id;
    const userId = req.auth.user._id.toString();

    log('info', `running ${action} for course '${courseId}'`);
    try {
      const { isPreview, buildData } = await FrameworkBuild.run({ action, courseId, userId });
      log('info', `finished ${action} for course '${courseId}'`);
      const urlRoot = isPreview ? framework.rootRouter.url : framework.apiRouter.url;
      res.json({ 
        [`${action}_url`]: `${urlRoot}/${action}/${buildData._id}/`,
        versions: buildData.versions
      });
    } catch(e) {
      log('error', `failed to ${action} course '${courseId}'`);
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
      
      const course = req.fileUpload.files.course;
      const importer = await FrameworkImport.run({
        unzipPath: course.filepath, 
        userId: req.auth.user._id.toString(), 
        importContent: req.body.importContent, 
        importPlugins: req.body.importPlugins, 
        updatePlugins: req.body.updatePlugins
      });
      const summary = await AdaptFrameworkUtils.getImportSummary(importer);
      res.json(summary);

    } catch(e) {
      log('error', `failed to import course, ${e}`);
      return next(e);
    }
  }
  /**
   * @typedef {AdaptFrameworkImportSummary}
   * @property {Array} adapt_framework Framework version map
   * @property {Array} PLUGIN_NAME Plugin version map
   * 
   * @param {AdaptFrameworkImport} importer The import instance
   * @return {AdaptFrameworkImportSummary} Object mapping all import versions to server installed versions
   * @example
   * {
   *   adapt_framework: [1.0.0, 2.0.0],
   *   adapt-contrib-vanilla: [1.0.0, 2.0.0]
   * }
   */
  static async getImportSummary(importer) {
    const {
      pkg: { version: fwVersion },
      idMap: { course: courseId },
      usedContentPlugins: usedPlugins,
      newContentPlugins: newPlugins
    } = importer;
    /**
     * Reduces input object to a map of plugin names to: [oldVersion, newVersion]
     */
    const reduce = (o, f) => Object.entries(o).reduce((m, [k, v]) => Object.assign(m, { [k]: f(k,v) }), {});
    /**
     * Get the server installed version of plugin by name
     */
    const [framework, contentplugin] = await App.instance.waitForModule('adaptframework', 'contentplugin');
    const installedPlugins = await contentplugin.find();
    const versionLookup = name => installedPlugins.find(p => p.name === name).version;

    return {
      courseId,
      versions: {
        adapt_framework: [fwVersion, framework.version],
        ...reduce(usedPlugins, (name, meta) => [meta.version, versionLookup(name)]),
        ...reduce(newPlugins, (name, meta) => [null, meta.version])
      }
    };
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
      const outputDir = path.resolve(App.instance.rootDir, App.instance.getConfig('uploadTempDir'));
      const time = new Date().getTime();
      const courseData = {
        name: `${time}.zip`,
        path: `${outputDir}/${time}`,
        type: 'application/zip'
      };
      return new Promise(async (resolve, reject) => {
        try {
          await fs.promises.mkdir(outputDir, { recursive: true });
        } catch(e) {
          if(e.code !== 'EEXIST') throw e;
        }
        responseData.pipe(fs.createWriteStream(courseData.path)).on('close', async () => {
          req.fileUpload = { files: { course: courseData } };
          req.fileUpload.files.course.filepath = await unzip(courseData.path, `${courseData.path}_unzip`, { removeSource: true });
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
      return next(App.instance.errors.FW_BUILD_NOT_FOUND.setData({ _id: id }));
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
        if(e.code === 'ENOENT') return next(App.instance.errors.NOT_FOUND.setData({ type: 'file', id: filePath }));
        return next(e);
      }
    }
  }
}

export default AdaptFrameworkUtils;