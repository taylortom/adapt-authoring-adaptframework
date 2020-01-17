const { App, DataQuery, Responder, Utils } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');
const util = require('util');

const previewCache = {};
/**
*
*/
class AdaptFrameworkUtils {
  static getBuildExpiry() {
    const now = new Date();
    now.setDate(now.getDate()+7);
    return now.toISOString();
  }
  static async retrievePreviewData(previewId) {
    if(previewCache[previewId]) {
      return previewCache[previewId];
    }
    const mdb = await App.instance.waitForModule('mongodb');
    const query = new DataQuery({ type: 'preview', fieldsMatching: { _id: previewId } });
    const data = await mdb.retrieve(query);

    if(data && data.length === 1) {
      previewCache[previewId] = data[0];
      return data[0];
    }
    throw new Error(`No preview found matching _id '${previewId}'`);
  }
  static async previewCourse(courseid) {
    const buildData = await this.buildCourse(courseid);
    const mdb = await App.instance.waitForModule('mongodb');
    return (await mdb.create({
      type: 'preview',
      courseId: courseid,
      location: buildData.dir,
      expiresAt: this.getBuildExpiry()
    }));
  }
  static async publishCourse(courseid) {
    const buildData = await this.buildCourse(courseid);
  }
  static async exportCourse(courseid) {
    this.doGruntBuild();
  }
  static async buildCourse(courseId, mode='prod', theme='adapt-contrib-vanilla', menu='adapt-contrib-boxMenu') {
    const dir = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());

    await fs.ensureDir(dir);
    await fs.copy((await App.instance.waitForModule('adaptFramework')).framework_dir, dir);
    await this.runGruntTask(`server-build:${mode} --theme=${theme} --menu=${menu}`, { cwd: dir });

    return { dir: path.join(dir, 'build') };
  }
  static async runGruntTask(command, options) {
    return new Promise((resolve, reject) => {
      exec(`grunt ${command}`, options, (error, stdout, stderr) => {
        if(error || stderr.length) return reject(error || stderr);
        resolve();
      });
    });
  }
}

module.exports = AdaptFrameworkUtils;
