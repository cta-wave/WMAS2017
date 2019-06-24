const Session = require("../data/session");

class TestManager {
  constructor() {
    this._timeouts = [];
  }

  /**
   *
   * @param {Object} config
   * @param {Session} config.session
   */
  nextTest({ onTimeout, session }) {
    let pendingTests = session.getPendingTests();
    let runningTests = session.getRunningTests();
    const testTimeout = session.getTestTimeout();
    const token = session.getToken();

    let test;
    let api;
    let hasHttp = true;
    let hasManual = true;
    let currentApi = 0;
    let currentTest = 0;
    const apis = Object.keys(pendingTests).sort((testA, testB) =>
      testA.toLowerCase() > testB.toLowerCase() ? 1 : -1
    );
    while (!test) {
      api = apis[currentApi];
      if (!api) return null;
      test = pendingTests[api][currentTest];

      if (!test) {
        currentApi++;
        currentTest = 0;

        if (currentApi === apis.length) {
          if (hasHttp) {
            hasHttp = false;
            currentApi = 0;
            test = null;
            continue;
          }

          if (hasManual) {
            hasManual = false;
            currentApi = 0;
            test = null;
            continue;
          }

          return null;
        }
        test = null;
        continue;
      }

      if (test.indexOf("https") !== -1) {
        if (hasHttp) {
          currentTest++;
          test = null;
          continue;
        }
      }

      if (test.indexOf("manual") === -1) {
        if (hasManual) {
          currentTest++;
          test = null;
          continue;
        }
      }
    }

    this._removeTestFromList(pendingTests, test, api);
    this._addTestToList(runningTests, test, api);

    if (testTimeout) {
      if (test.indexOf("manual") !== -1) {
        this._timeouts.push({
          test,
          timeout: setTimeout(() => onTimeout(token, test), 5 * 60 * 1000)
        });
      } else {
        this._timeouts.push({
          test,
          timeout: setTimeout(() => onTimeout(token, test), testTimeout + 10000)
        });
      }
    }
    session.setPendingTests(pendingTests);
    session.setRunningTests(runningTests);
    return test;
  }

  /**
   * 
   * @param {Object} config
   * @param {Session} config.session 
   */
  completeTest({test, session}) {
    let runningTests = session.getRunningTests();
    let completedTests = session.getCompletedTests();
    let clients = session.getClients();

    const api = test.split("/")[0];
    this._removeTestFromList(runningTests, test, api);
    this._addTestToList(completedTests, test, api);
    for (let i = 0; i < this._timeouts.length; i++) {
      if (this._timeouts[i].test === test) {
        clearTimeout(this._timeouts[i].timeout);
        this._timeouts.splice(i, 1);
        break;
      }
    }
    clients.forEach(client => client.send("complete"));

    session.setRunningTests(runningTests);
    session.setCompletedTests(completedTests);
  }

  _removeTestFromList(testList, test, api) {
    if (!testList[api]) return;
    const index = testList[api].indexOf(test);
    if (index === -1) return;
    testList[api].splice(index, 1);
    if (testList[api].length === 0) {
      delete testList[api];
    }
  }

  _addTestToList(testList, test, api) {
    if (testList[api] && testList[api].indexOf(test) !== -1) return;
    if (!testList[api]) testList[api] = [];
    testList[api].push(test);
  }
}

module.exports = TestManager;
