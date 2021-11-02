const axios = require('axios');
const glob = require('glob');
const exec = require('child_process').exec;
/**
 * Shim for the CLI
 */
class AdaptCli {
  /**
   * Installs a clean copy of the framework
   * @param {object} options
   * @param {String} options.version Specific version of the framework to install
   * @param {String} [options.dir] Directory to install into
   * @return {Promise}
   */
   static async installFramework ({ version, dir, repo } = {}) {
    const opts = { cwd: dir };
    return new Promise(async (resolve, reject) => {
      exec(`git clone --depth 1 --branch ${version} ${repo}`, opts, e1 => {
        if(e1) return reject(e1);
        exec(`git submodule init`, opts, e2 => {
          if(e2) return reject(e2);
          exec(`npm ci`, opts, e3 => e3 ? reject(e3) : resolve());
        });
      });
    });
  }

  /**
   * Runs the build for a current course
   * @param {Object} options
   * @param {String} [options.dir] Root path of the framework installation
   * @param {Boolean} options.devMode Whether to run the build in developer mode
   * @return {Promise}
   */
  static async buildCourse ({ devMode = false, dir = process.cwd(), theme, menu } = {}) {
    return new Promise((resolve, reject) => {
      const command = `grunt server-build:${devMode ? 'dev' : 'prod'} --theme=${theme} --menu=${menu}`;
      exec(command, { cwd: dir }, e => e ? reject(e) : resolve());
    });
  }

  /**
   * Retrieves all schema defined in the framework
   * @param {Object} options
   * @param {String} [options.dir] Root path of the framework installation
   * @return {Promise} Resolves with array of JSON schema contents
   */
  static async getSchemas ({ dir }) {
    return new Promise((resolve, reject) => {
      glob(`${dir}/src/**/schema/*.schema.json`, (error, files) => {
        error ? reject(error) : resolve(files);
      });
    });
  }

  /**
   * Loads a single JSON schema file by name
   * @param {Object} options
   * @param {String} options.name Name of the schema to load
   * @return {Promise} Resolves with JSON schema contents
   */
  static async getSchema ({ name } = {}) {

  }
  /**
   * Gets the update information for installed framework/plugins
   * @param {String} plugin Name of plugin (if not specified, all plugins are checked), should also accept 'adapt_framework'
   * @param {String} dir Root path of the framework installation
   * @return {Promise} Resolves with array/object with plugin update info (see below)
   */
   static async getUpdateInfo(plugin, dir) {
    return { installed: undefined, latest: 'v5.17.6', compatible: 'v5.17.6' };
    // return { installed: 'v5.17.6', latest: 'v5.17.6', compatible: 'v5.17.6' };
    let installed;
    try {
      const { version } = require(`${process.cwd()}/temp/adapt_framework/package.json`);
      installed = version;
    } catch(e) {}
    const { data } = await axios.get('https://api.github.com/repos/adaptlearning/adapt_framework/releases');
    return { installed, latest: data[0].tag_name, compatible: data[0].tag_name };
  }
}

module.exports = AdaptCli;
