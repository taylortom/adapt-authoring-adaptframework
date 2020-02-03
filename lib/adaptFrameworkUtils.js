const { App, DataQuery, Responder, Utils } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const zipper = require('zipper');
// TODO this needs to be done properly
const buildCache = {};

class AdaptFrameworkUtils {
  static getBuildExpiry() {
    const now = new Date();
    now.setDate(now.getDate()+7);
    return now.toISOString();
  }
  static async recordBuildAttempt(courseId, action, userId, location) {
    const mdb = await App.instance.waitForModule('mongodb');
    return (await mdb.insert('adaptbuilds', {
      action: action,
      courseId: courseId,
      location: location,
      expiresAt: AdaptFrameworkUtils.getBuildExpiry(),
      createdBy: userId
    }));
  }
  static async createLocalFramework(dir) {
    await fs.copy(Utils.getModuleDir('adapt_framework'), dir);

    const binPath = path.join(App.instance.getConfig('root_dir'), 'node_modules', 'adapt-cli', 'bin', 'adapt');
    await AdaptFrameworkUtils.runShellTask(`${binPath} install`, { cwd: dir });
  }
  static async retrieveBuildData(id) {
    if(buildCache[id]) {
      return buildCache[id];
    }
    const mdb = await App.instance.waitForModule('mongodb');
    let data;
    try {
      data = (await mdb.find('adaptbuilds', { _id: id }));
    } catch(e) {
      throw new Error(`Error retrieving build data, '${e.message}'`);
    }
    if(data.length !== 1) {
      const e = new Error(`No build found matching _id '${id}'. Check it is valid, and has not expired.`);
      e.statusCode = Responder.StatusCodes.Error.Missing;
      throw e;
    }
    buildCache[id] = data[0];
    return data[0];
  }
  static async performCourseAction(courseId, action, userId) {
    const isPreview = action === 'preview';
    const isPublish = action === 'publish';
    const isExport = action === 'export';

    const buildDir = (await AdaptFrameworkUtils.buildCourse(courseId)).dir;
    let location, zipPath;

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
      const zip = await zipper.zip(zipPath, outputPath, { removeSource: true });
      location = outputPath;
    }
    const attemptData = await AdaptFrameworkUtils.recordBuildAttempt(courseId, action, userId, location);
    return attemptData;
  }
  static async buildCourse(courseId, mode='prod', theme='adapt-contrib-vanilla', menu='adapt-contrib-boxMenu') {
    const dir = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());

    await fs.ensureDir(dir);
    await fs.copy((await App.instance.waitForModule('adaptFramework')).framework_dir, dir);
    await AdaptFrameworkUtils.runShellTask(`grunt server-build:${mode} --theme=${theme} --menu=${menu}`, { cwd: dir });

    return { dir };
  }
  static async runShellTask(command, options) {
    return new Promise((resolve, reject) => {
      exec(`${command}`, options, (error, stdout, stderr) => {
        if(error || stderr.length) return reject(error || stderr);
        resolve();
      });
    });
  }
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
  static async getHandler(req, res, next) {
    const action = AdaptFrameworkUtils.inferAction(req);
    const id = req.params.id;
    let buildData, filePath;
    try {
      buildData = await AdaptFrameworkUtils.retrieveBuildData(id);
    } catch(e) {
      return next(e);
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
  static inferAction(req) {
    return req.url.slice(1, req.url.indexOf('/', 1));
  }
}

module.exports = AdaptFrameworkUtils;
