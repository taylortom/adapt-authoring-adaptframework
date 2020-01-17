const exec = require('child_process').exec;
const fs = require('fs-extra');
const path = require('path');
/**
*
*/
class AdaptFrameworkUtils {
  static get frameworkDir() {
    return path.join(this.app.getConfig('root_dir'), 'node_modules', 'adapt_framework');
  }
  static async doGruntBuild(dir, mode='prod', theme='adapt-contrib-vanilla', menu='adapt-contrib-boxMenu') {
    return new Promise((resolve, reject) => {
      const command = `grunt server-build:${mode} --theme=${theme} --menu=${menu}`;
      const opts = { cwd: dir };
      exec(command, opts, (error, stdout, stderr) => {
        if(error) console.log(error);
        if(stdout) console.log(stdout);
        if(stderr) console.log(stderr);
        if(error || stderr.length) return reject(error || stderr);
        resolve();
      });
    });
  }
  static servePreview(req, res, next) {
    res.send('servePreview');
  }
  static async buildCourse(courseId) {
    const dir = path.join(this.app.getConfig('temp_dir'), 'builds', new Date().getTime().toString());
    await fs.ensureDir(dir);
    await fs.copy(this.frameworkDir, dir);
    await this.doGruntBuild(dir);
    return { dir: path.join(dir, 'build') };
  }
}

module.exports = AdaptFrameworkModule;
