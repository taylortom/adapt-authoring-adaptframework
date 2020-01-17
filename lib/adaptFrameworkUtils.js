const { App, DataQuery, Responder, Utils } = require('adapt-authoring-core');
const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');

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
  static async doGruntBuild(dir, mode='prod', theme='adapt-contrib-vanilla', menu='adapt-contrib-boxMenu') {
    return new Promise((resolve, reject) => {
      const command = `grunt server-build:${mode} --theme=${theme} --menu=${menu}`;
      const opts = { cwd: dir };
      exec(command, opts, (error, stdout, stderr) => {
        // TODO do something with these logs...
        if(error) console.log(error);
        if(stdout) console.log(stdout);
        if(stderr) console.log(stderr);
        if(error || stderr.length) return reject(error || stderr);
        resolve();
      });
    });
  }
  static async buildCourse(courseId) {
    const adaptFramework = await App.instance.waitForModule('adaptFramework');
    const dir = path.join(App.instance.getConfig('temp_dir'), 'builds', new Date().getTime().toString());
    await fs.ensureDir(dir);
    await fs.copy(adaptFramework.framework_dir, dir);
    await this.doGruntBuild(dir);
    return { dir: path.join(dir, 'build') };
  }
}

module.exports = AdaptFrameworkUtils;
