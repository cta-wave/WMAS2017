const path = require("path");
const JSZip = require("jszip");

const FileSystem = require("../../utils/file-system");
const UserAgentParser = require("../../utils/user-agent-parser");
const WptReport = require("../wpt-report");
const Serializer = require("../../utils/serializer");
const Deserializer = require("../../utils/deserializer");
const SessionManager = require("../../network/session-manager");
const Session = require("../../data/session");
const ResultComparator = require("./result-comparator");
const Database = require("../../database");
const TestManager = require("../../testing/test-manager");

const print = text => process.stdout.write(text);
const println = text => console.log(text);

/**
 * @module ResultsManager
 */
class ResultsManager {
  /**
   * @constructor
   * @param {Object} config
   * @param {SessionManager} config.sessionManager
   * @param {TestManager} config.testManager
   * @param {Database} config.database
   */
  constructor({
    resultsDirectoryPath,
    database,
    sessionManager,
    testManager,
    exportTemplateDirectoryPath
  }) {
    this._resultsDirectoryPath = resultsDirectoryPath;
    this._database = database;
    this._sessionManager = sessionManager;
    this._testManager = testManager;
    this._generatingComparisons = [];
    this._exportTemplateDirectoryPath = exportTemplateDirectoryPath;
    this._resultComparator = new ResultComparator({
      resultsDirectoryPath,
      resultsManager: this
    });
  }

  async createResult({ token, data }) {
    const result = this.prepareResult(data);
    let { test } = result;
    if (test.startsWith("/")) test = test.substr(1);

    const session = await this._sessionManager.readSession(token);
    if (!session) return;
    if (!session.testExists(test)) return;

    if (!session.isTestComplete(test)) {
      this._testManager.completeTest({ test, session });
      await this._database.createResult(token, result);
      const api = test.split("/")[0];
      if (session.isApiComplete(api)) {
        await this.saveApiResults({ token, api });
        await this.generateReport({ token, api });
      }
    }
    const testFilesCompleted = session.getTestFilesCompleted();
    const testFilesCount = session.getTestFilesCount();
    if (
      !Object.keys(testFilesCount).some(
        api =>
          !testFilesCompleted[api] ||
          testFilesCompleted[api] !== testFilesCount[api]
      )
    ) {
      session.setStatus(Session.COMPLETED);
      await this.createInfoFile(session);
    }
    await this._sessionManager.updateSession(session);
  }

  async readFlattenedResults(token) {
    const results = await this.getResults(token);
    return this._flattenResults(results);
  }

  async readResultComparison({ tokens, refTokens }) {
    await Promise.all(
      refTokens
        .filter(token => !token.includes("-"))
        .map(async (token, index) => {
          refTokens.splice(index, 1);
          const hashTokens = await this._resultsManager.getTokensFromHash(
            token
          );
          refTokens = refTokens.concat(hashTokens);
        })
    );
    let comparison = await this._resultComparator.readComparison({
      tokens,
      refTokens
    });
    if (!comparison) {
      comparison = await this._resultComparator.generateComparison({
        tokens,
        refTokens
      });
    }
    return comparison;
  }

  async readResultApiHtmlReportPath({ tokens, refTokens, token, api }) {
    if (refTokens && refTokens.length > 0)
      throw new Error("WPT Reports using ref tokens is not supported yet!");

    // Single report
    if (token) {
      return `${token}/${api}/all.html`;
    }

    // Multi report
    const comparisonDirectoryName = this._resultComparator.getComparisonDirectoryName(
      {
        tokens,
        refTokens
      }
    );

    const comparisonDirectoryPath = path.join(
      this._resultsDirectoryPath,
      comparisonDirectoryName
    );

    if (!(await FileSystem.exists(comparisonDirectoryPath))) {
      await FileSystem.makeDirectory(comparisonDirectoryPath);
    }

    const apiDirectoryPath = path.join(comparisonDirectoryPath, api);
    if (!(await FileSystem.exists(apiDirectoryPath))) {
      await FileSystem.makeDirectory(apiDirectoryPath);

      const resultJsonFiles = await Promise.all(
        tokens.map(async token => ({
          token,
          path: await this.getJsonPath({ token, api })
        }))
      );
      await WptReport.generateMultiReport({
        outputHtmlDirectoryPath: apiDirectoryPath,
        specName: api,
        resultJsonFiles
      });
    }

    return `${comparisonDirectoryName}/${api}/all.html`;
  }

  async getJsonPath({ token, api }) {
    const session = await this._sessionManager.readSession(token);
    return this._getFilePath({
      userAgent: session.getUserAgent(),
      api,
      token
    });
  }

  async saveApiResults({ token, api }) {
    const apiResults = { results: (await this.getResults(token))[api] };
    const session = await this._sessionManager.readSession(token);

    await this._ensureResultsDirectoryExistence({ api, token, session });

    const filePath = await this.getJsonPath({ token, api });
    await FileSystem.writeFile(filePath, JSON.stringify(apiResults, null, 2));
  }

  async deleteResults(token) {
    const resultDirectory = path.join(this._resultsDirectoryPath, token);
    if (!(await FileSystem.exists(resultDirectory))) return;
    await FileSystem.removeDirectory(resultDirectory);
  }

  async loadResults() {
    const sessionManager = this._sessionManager;
    const resultsDirectoryPath = this._resultsDirectoryPath;
    if (!(await FileSystem.exists(resultsDirectoryPath))) return;
    const tokens = await FileSystem.readDirectory(resultsDirectoryPath);
    const sessions = await sessionManager.readSessions();
    println("Looking for results to import ...");
    for (let token of tokens) {
      if (sessions.find(session => session.getToken() === token)) continue;
      // http://webapitests2017.ctawave.org:8050/?
      //   path=/2dcontext,%20/css,%20/content-security-policy,%20/dom,%20/ecmascript,%20/encrypted-media,%20/fetch,%20/fullscreen,%20/html,%20/IndexedDB,%20/media-source,%20/notifications,%20/uievents,%20/WebCryptoAPI,%20/webaudio,%20/webmessaging,%20/websockets,%20/webstorage,%20/workers,%20/xhr
      //   &reftoken=ce4aec10-7855-11e8-b81b-6714c602f007

      // http://webapitests2017.ctawave.org:8050/?path=/2dcontext,%20/css,%20/content-security-policy,%20/dom,%20/ecmascript,%20/encrypted-media,%20/fetch,%20/fullscreen,%20/html,%20/IndexedDB,%20/media-source,%20/notifications,%20/uievents,%20/WebCryptoAPI,%20/webaudio,%20/webmessaging,%20/websockets,%20/webstorage,%20/workers,%20/xhr
      // &reftoken=01d11810-7938-11e8-8749-a6ac1d216fc7,a831a820-7855-11e8-9ce0-d6175576bb4b,c0cdb6c0-7b99-11e8-939a-90ffd3c0ec6f,ce4aec10-7855-11e8-b81b-6714c602f007
      const resultDirectoryPath = path.join(resultsDirectoryPath, token);
      const infoFilePath = path.join(resultDirectoryPath, "info.json");
      if (!(await FileSystem.exists(infoFilePath))) continue;
      const infoFile = await FileSystem.readFile(infoFilePath);
      const info = JSON.parse(infoFile);
      info.token = token;
      const { browser } = UserAgentParser.parse(info.user_agent);
      print(`Loading ${browser.name} ${browser.version} results ...`);
      const session = Deserializer.deserializeSession(info);
      await sessionManager.addSession(session);
      const apis = await FileSystem.readDirectory(resultDirectoryPath);
      for (let api of apis) {
        const apiPath = path.join(resultDirectoryPath, api);
        if (!(await FileSystem.stats(apiPath)).isDirectory()) continue;
        const resultsFile = (await FileSystem.readDirectory(apiPath)).find(
          file => /\w\w\d{1,3}\.json/.test(file)
        );
        const resultsFilePath = path.join(apiPath, resultsFile);
        const { results } = JSON.parse(
          await FileSystem.readFile(resultsFilePath)
        );
        for (let result of results) {
          await this._database.createResult(token, result);
        }
      }
      println(" done.");
    }
  }

  async generateReport({ token, api }) {
    const filePath = await this.getJsonPath({ token, api });
    const dirPath = path.dirname(filePath);
    await WptReport.generateReport({
      inputJsonDirectoryPath: dirPath,
      outputHtmlDirectoryPath: dirPath,
      specName: api
    });
  }

  async getTokensFromHash(hash) {
    let tokens = [];
    const tempPath = path.join(this._resultsDirectoryPath, hash);
    if (await FileSystem.exists(tempPath)) {
      const tokenUaRegex = /(.+)[-]([a-zA-Z]{2}\d+).json/;
      const apiNames = await FileSystem.readDirectory(tempPath);
      const targetFolder = path.join(tempPath, apiNames[0]);
      tokens = await FileSystem.readDirectory(targetFolder);
      tokens = tokens.filter(name => {
        return tokenUaRegex.exec(name);
      });
      for (let i = 0; i < tokens.length; i++) {
        tokens[i] = tokens[i].replace(/(-[a-zA-Z]{2}\d+).json/, "");
      }
    }
    return tokens;
  }

  async _ensureResultsDirectoryExistence({ token, api, session }) {
    if (!(await FileSystem.exists(this._resultsDirectoryPath))) {
      await FileSystem.makeDirectory(this._resultsDirectoryPath);
    }

    let directory = path.join(this._resultsDirectoryPath, token);
    if (!(await FileSystem.exists(directory))) {
      await FileSystem.makeDirectory(directory);
    }

    directory = path.join(directory, api);
    if (!(await FileSystem.exists(directory))) {
      await FileSystem.makeDirectory(directory);
    }

    this.createInfoFile(session);
  }

  async createInfoFile(session) {
    const token = session.getToken();
    const infoFilePath = path.join(
      this._resultsDirectoryPath,
      token,
      "info.json"
    );
    let info = Serializer.serializeSession(session);
    delete info.running_tests;
    delete info.pending_tests;
    delete info.completed_tests;
    await FileSystem.writeFile(infoFilePath, JSON.stringify(info, null, "  "));
  }

  _getFilePath({ userAgent, api, token }) {
    const apiDirectory = path.join(this._resultsDirectoryPath, token, api);
    return path.join(apiDirectory, this._getFileName(userAgent));
  }

  _getFileName(userAgent) {
    const {
      browser: { name, version }
    } = UserAgentParser.parse(userAgent);
    const abbreviation = UserAgentParser.abbreviateBrowserName(name);
    return abbreviation + version + ".json";
  }

  async getResults(token) {
    const results = await this._database.readResults(token);
    const resultsPerApi = {};
    results.forEach(result => {
      let api;
      if (result.test.startsWith("/")) {
        api = result.test.split("/")[1];
      } else {
        api = result.test.split("/")[0];
      }
      if (!resultsPerApi[api]) resultsPerApi[api] = [];
      delete result._id;
      resultsPerApi[api].push(result);
    });

    return resultsPerApi;
  }

  prepareResult(result) {
    const harness_status_map = {
      0: "OK",
      1: "ERROR",
      2: "TIMEOUT",
      3: "NOTRUN"
    };
    const subtest_status_map = {
      0: "PASS",
      1: "FAIL",
      2: "TIMEOUT",
      3: "NOTRUN"
    };

    if (result.tests) {
      result.tests.forEach(test => {
        test.status = subtest_status_map[test.status];
        delete test.stack;
      });
      result.subtests = result.tests;
      delete result.tests;
    }

    delete result.stack;
    result.status = harness_status_map[result.status];

    return result;
  }

  _flattenResults(results) {
    const flattenedResults = {};
    for (let api in results) {
      if (!flattenedResults[api]) {
        flattenedResults[api] = {
          pass: 0,
          fail: 0,
          timeout: 0,
          timeoutfiles: [],
          not_run: 0
        };
      }
      for (let result of results[api]) {
        if (!result.subtests) {
          switch (result.status) {
            case "OK":
              flattenedResults[api].pass++;
              break;
            case "ERROR":
              flattenedResults[api].fail++;
              break;
            case "TIMEOUT":
              flattenedResults[api].timeout++;
              break;
            case "NOTRUN":
              flattenedResults[api].not_run++;
              break;
          }
          if (results.xstatus === "SERVERTIMEOUT") {
            flattenedResults[api].timeoutfiles.push(result.test);
          }
          continue;
        }
        for (let test of result.subtests) {
          switch (test.status) {
            case "PASS":
              flattenedResults[api].pass++;
              break;
            case "FAIL":
              flattenedResults[api].fail++;
              break;
            case "TIMEOUT":
              flattenedResults[api].timeout++;
              break;
            case "NOTRUN":
              flattenedResults[api].not_run++;
              break;
          }
          if (test.xstatus === "SERVERTIMEOUT") {
            flattenedResults[api].timeoutfiles.push(result.test);
          }
        }
      }
    }
    return flattenedResults;
  }

  async exportResults(token) {
    const zip = new JSZip();

    const flattenedResults = await this.readFlattenedResults(token);
    const resultsScript =
      "const results = " + JSON.stringify(flattenedResults, null, 2);
    zip.file("results.json.js", resultsScript);

    const session = await this._sessionManager.readSession(token);
    const sessionJson = Serializer.serializeSession(session);
    delete sessionJson.running_tests;
    delete sessionJson.completed_tests;
    delete sessionJson.pending_tests;
    const detailsScript =
      "const details = " + JSON.stringify(sessionJson, null, 2);
    zip.file("details.json.js", detailsScript);

    const readDirectoryFiles = async directoryPath => {
      const fileNames = await FileSystem.readDirectory(directoryPath);
      let files = [];
      for (let fileName of fileNames) {
        const filePath = path.join(directoryPath, fileName);
        const stats = await FileSystem.stats(filePath);
        if (stats.isDirectory()) {
          files = files.concat(await readDirectoryFiles(filePath));
        } else {
          files.push({
            filePath,
            data: await FileSystem.readFile(filePath)
          });
        }
      }
      return files;
    };

    const files = await readDirectoryFiles(this._exportTemplateDirectoryPath);
    files.forEach(file => {
      const filePath = file.filePath.replace(
        this._exportTemplateDirectoryPath,
        ""
      );
      zip.file(filePath, file.data);
    });

    return zip.generateAsync({ type: "nodebuffer" });
  }
}

module.exports = ResultsManager;
