import { App } from 'adapt-authoring-core';
import FrameworkBuild from './AdaptFrameworkBuild.js';
import FrameworkImport from './AdaptFrameworkImport.js';
import fs from 'fs';
import path from 'path';
import semver from 'semver';

/** @ignore */ const buildCache = {};

let fw;
/**
 * Logs a message using the framework module
 * @param {...*} args Arguments to be logged
 */
/** @ignore */
async function log(...args) {
  if(!fw) fw = await App.instance.waitForModule('adaptframework');
  return fw.log(...args);
}
/**
 * Utilities for use with the AdaptFrameworkModule
 * @memberof adaptframework
 */
class AdaptFrameworkUtils {
  /**
   * Infers the framework action to be executed from a given request URL
   * @param {external:ExpressRequest} req
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
   * @typedef {AdaptFrameworkImportSummary}
   * @property {String} title Course title
   * @property {String} courseId Course _id
   * @property {Object} statusReport Status report
   * @property {Object<String>} statusReport.info Information messages
   * @property {Array<String>} statusReport.warn Warning messages
   * @property {Object} content Object mapping content types to the number of items of that type found in the imported course
   * @property {Object} versions A map of plugins used in the imported course and their versions 
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
    const [framework, contentplugin] = await App.instance.waitForModule('adaptframework', 'contentplugin');
    const installedPlugins = await contentplugin.find();
    const {
      pkg: { name: fwName, version: fwVersion },
      idMap: { course: courseId },
      contentJson,
      usedContentPlugins: usedPlugins,
      newContentPlugins: newPlugins,
      statusReport,
      settings: { updatePlugins }
    } = importer;
    const versions = [
      { name: fwName, versions: [fwVersion, framework.version] }, 
      ...Object.values(usedPlugins), 
      ...Object.values(newPlugins)
    ].map(meta => {
        const p = installedPlugins.find(p => p.name === meta.name);
        const versions = meta.versions ?? [p?.version, meta.version];
        return { 
          name: meta.name,
          status: this.getPluginUpdateStatus(versions, p?.isLocalInstall, updatePlugins),
          versions
        };
      });
    return {
      title: contentJson.course.displayTitle || contentJson.course.title,
      courseId,
      statusReport,
      content: this.getImportContentCounts(contentJson),
      versions
    };
  }
  /**
   * Determines the update status code
   * @param {Array} versions 
   * @param {Boolean} isLocalInstall 
   * @param {Boolean} updatePlugins 
   * @returns {String} The update status code
   */
  static getPluginUpdateStatus(versions, isLocalInstall, updatePlugins) {
    const [installedVersion, importVersion] = versions;
    if(!installedVersion) return 'INSTALLED';
    if(semver.lt(importVersion, installedVersion)) return 'OLDER';
    if(semver.gt(importVersion, installedVersion)) {
      if(!updatePlugins && !isLocalInstall) return 'UPDATE_BLOCKED';
      return 'UPDATED';
    }
    return 'NO_CHANGE';
  }
  /**
   * Returns a map of content types and their instance count in the content JSON
   * @param {Object} content Course content
   * @returns {Object}
   */
  static getImportContentCounts(content) {
    return Object.values(content).reduce((m, c) => {
      const items = c._type ? [c] : Object.values(c);
      return items.reduce((m, { _type }) => {
        return { ...m, [_type]: m[_type] !== undefined ? m[_type]+1 : 0 };
      }, m);
    }, {});
  }
  /**
   * Handles GET requests to the API
   * @param {external:ExpressRequest} req
   * @param {external:ExpressResponse} res
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
      if(!req.auth.user) {
        return res.status(App.instance.errors.MISSING_AUTH_HEADER.statusCode).end();
      }
      const filePath = path.resolve(buildData.location, req.path.slice(req.path.indexOf(id)+id.length+1) || 'index.html');
      try {
        await fs.promises.stat(filePath);
        res.sendFile(filePath);
      } catch(e) {
        if(e.code === 'ENOENT') return next(App.instance.errors.NOT_FOUND.setData({ type: 'file', id: filePath }));
        return next(e);
      }
    }
  }
  /**
   * Handles POST requests to the API
   * @param {external:ExpressRequest} req
   * @param {external:ExpressResponse} res
   * @param {Function} next
   * @return {Promise}
   */
  static async postHandler(req, res, next) {
    const startTime = Date.now();
    const framework = await App.instance.waitForModule('adaptframework');
    const action = AdaptFrameworkUtils.inferBuildAction(req);
    const courseId = req.params.id;
    const userId = req.auth.user._id.toString();

    log('info', `running ${action} for course '${courseId}'`);
    try {
      const { isPreview, buildData } = await FrameworkBuild.run({ action, courseId, userId });
      const duration = Math.round((Date.now()-startTime)/10)/100;
      log('info', `finished ${action} for course '${courseId}' in ${duration} seconds`);
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
   * @param {external:ExpressRequest} req
   * @param {external:ExpressResponse} res
   * @param {Function} next
   * @return {Promise}
   */
  static async importHandler(req, res, next) {
    try {
      log('info', `running course import`);

      await AdaptFrameworkUtils.handleImportFile(req, res);
      
      const [course] = req.fileUpload.files.course;
      const importer = await FrameworkImport.run({
        unzipPath: course.filepath, 
        userId: req.auth.user._id.toString(), 
        isDryRun: AdaptFrameworkUtils.toBoolean(req.body.dryRun), 
        importContent: AdaptFrameworkUtils.toBoolean(req.body.importContent), 
        importPlugins: AdaptFrameworkUtils.toBoolean(req.body.importPlugins), 
        updatePlugins: AdaptFrameworkUtils.toBoolean(req.body.updatePlugins)
      });
      const summary = await AdaptFrameworkUtils.getImportSummary(importer);
      res.json(summary);

    } catch(e) {
      log('error', `failed to import course, ${e}`);
      return next(e);
    }
  }
  /**
   * Converts a body value to a valid boolean
   * @param {*} val 
   * @returns {Boolean}
   */
  static toBoolean(val) {
    if(val !== undefined) return val === true || val === 'true';
  }
  /**
   * Deals with an incoming course (supports both local zip and remote URL stream)
   * @param {external:ExpressRequest} req
   * @param {external:ExpressResponse} res
   * @return {Promise}
   */
  static async handleImportFile(req, res) {
    const middleware = await App.instance.waitForModule('middleware');
    const handler = req.get('Content-Type').indexOf('multipart/form-data') === 0 ?
      middleware.fileUploadParser :
      middleware.urlUploadParser;
    return new Promise((resolve, reject) => {
      handler(middleware.zipTypes, { unzip: true })(req, res, e => e ? reject(e) : resolve());
    });
  }
}

export default AdaptFrameworkUtils;