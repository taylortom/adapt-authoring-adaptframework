const { App, DataQuery, Responder, Utils } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
// TODO this needs to be done properly
const buildCache = {};
/**
*
*/
class AdaptFrameworkUtils {
  static getBuildExpiry() {
    const now = new Date();
    now.setDate(now.getDate()+7);
    return now.toISOString();
  }
  static async recordBuildAttempt(action, courseid, dir) {
    const mdb = await App.instance.waitForModule('mongodb');
    return (await mdb.create({
      type: 'adaptbuild',
      action: action,
      courseId: courseid,
      location: dir,
      expiresAt: this.getBuildExpiry()
    }));
  }
  static async createLocalFramework() {
    await fs.copy(Utils.getModuleDir('adapt_framework'), dir);
    await fs.move(path.join(dir, 'adapt-framework.json'), path.join(dir, 'adapt.json'));

    const binPath = path.join(this.app.getConfig('root_dir'), 'node_modules', 'adapt-cli', 'bin', 'adapt');
    await this.runShellTask(`${binPath} install`, { cwd: dir });
  }
  static async retrieveBuildData(id) {
    if(buildCache[id]) {
      return buildCache[id];
    }
    const mdb = await App.instance.waitForModule('mongodb');
    const query = new DataQuery({ type: 'build', fieldsMatching: { _id: id } });
    let data;
    try {
      data = (await mdb.retrieve(query));
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
  static async performCourseAction(courseid, action) {
    const buildData = await this.buildCourse(courseid);
    const attemptData = await this.recordBuildAttempt(action, courseid, buildData.dir);
    return attemptData;
  }
  static async buildCourse(courseId, mode='prod', theme='adapt-contrib-vanilla', menu='adapt-contrib-boxMenu') {
    const dir = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());

    await fs.ensureDir(dir);
    await fs.copy((await App.instance.waitForModule('adaptFramework')).framework_dir, dir);
    await this.runShellTask(`grunt server-build:${mode} --theme=${theme} --menu=${menu}`, { cwd: dir });

    return { dir: path.join(dir, 'build') };
  }
  static async runShellTask(command, options) {
    return new Promise((resolve, reject) => {
      exec(`${command}`, options, (error, stdout, stderr) => {
        if(error || stderr.length) return reject(error || stderr);
        resolve();
      });
    });
  }
}

module.exports = AdaptFrameworkUtils;
