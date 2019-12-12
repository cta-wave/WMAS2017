const Database = require("./database");
const Deserializer = require("../utils/deserializer");
const Serializer = require("../utils/serializer");
const JobQueue = require("../utils/job-queue");
const Session = require("../data/session");

const DEFAULT_FILE_PATH = "./sessions.db";
const DEFAULT_COMPACTION_INTERVAL = 60000;

const READ_JOB_GROUP = "read";
const MAX_ACCESS_JOBS = 1;
const MAX_GROUP_JOBS = 5;

class SessionsDatabase extends Database {
  constructor() {
    super();
    this._sessionsAccessQueue = new JobQueue(MAX_ACCESS_JOBS, {
      groupLimit: MAX_GROUP_JOBS
    });
    this._queueSessionsAccess = this._sessionsAccessQueue.queueJob.bind(
      this._sessionsAccessQueue
    );
  }

  async initialize({
    filePath = DEFAULT_FILE_PATH,
    resultsDatabase,
    testsDatabase,
    compactionInterval = DEFAULT_COMPACTION_INTERVAL
  } = {}) {
    const sessionsDataStore = this._createDataStore({
      filePath,
      compactionInterval
    });
    await sessionsDataStore.loadDatabase();
    this._db = sessionsDataStore;
    this._resultsDatabase = resultsDatabase;
    this._testsDatabase = testsDatabase;
  }

  async createSession(session) {
    return this._queueSessionsAccess(() => this._createSession(session));
  }

  async _createSession(session) {
    const token = session.getToken();
    const sessionObject = Serializer.serializeSession(session);

    await this._resultsDatabase.loadDatabase(token);

    await this._testsDatabase.loadDatabase(token);
    const tests = {};
    const { COMPLETED, ABORTED } = Session;
    if (session.getStatus() !== COMPLETED && session.getStatus() !== ABORTED) {
      const { pending_tests, running_tests, completed_tests } = sessionObject;
      tests.pending_tests = pending_tests;
      tests.running_tests = running_tests;
      tests.completed_tests = completed_tests;
    }
    const { malfunctioning_tests } = sessionObject;
    tests.malfunctioning_tests = malfunctioning_tests;
    await this._testsDatabase.createTests(token, tests);

    delete sessionObject.completed_tests;
    delete sessionObject.running_tests;
    delete sessionObject.pending_tests;
    delete sessionObject.malfunctioning_tests;
    await this._db.insert(sessionObject);
  }

  async readSession(token) {
    return this._queueSessionsAccess(() => this._readSession(token), {
      group: READ_JOB_GROUP
    });
  }

  async _readSession(token) {
    const result = await this._db.find({ token });
    if (!result || result.length === 0) {
      return null;
    }
    const session = Deserializer.deserializeSession(result[0]);

    await this._testsDatabase.loadDatabase(token);
    const tests = await this._testsDatabase.readTests(token);
    if (tests) {
      const { COMPLETED, ABORTED } = Session;
      if (
        session.getStatus() !== COMPLETED &&
        session.getStatus() !== ABORTED
      ) {
        const { pending_tests, running_tests, completed_tests } = tests;
        if (pending_tests) session.setPendingTests(pending_tests);
        if (completed_tests) session.setCompletedTests(completed_tests);
        if (running_tests) session.setRunningTests(running_tests);
      }
      const { malfunctioning_tests } = tests;
      if (malfunctioning_tests)
        session.setMalfunctioningTests(malfunctioning_tests);
    }
    return session;
  }

  async readSessions() {
    return this._queueSessionsAccess(() => this._readSessions(), {
      group: READ_JOB_GROUP
    });
  }

  async _readSessions() {
    const result = await this._db.find({});
    if (!result) {
      return [];
    }
    return Deserializer.deserializeSessions(result);
  }

  async readExpiringSessions() {
    return this._queueSessionsAccess(() => this._readExpiringSession(), {
      group: READ_JOB_GROUP
    });
  }

  async _readExpiringSession() {
    const result = await this._db.find({ expiration_date: { $ne: null } });
    if (!result) return [];
    return Deserializer.deserializeSessions(result);
  }

  async readPublicSessions() {
    return this._queueSessionsAccess(() => this._readPublicSessions(), {
      group: READ_JOB_GROUP
    });
  }

  async _readPublicSessions() {
    const result = await this._db.find({ is_public: true });
    if (!result) {
      return [];
    }
    return Deserializer.deserializeSessions(result);
  }

  async updateSession(session) {
    return this._queueSessionsAccess(() => this._updateSession(session));
  }

  async _updateSession(session) {
    const token = session.getToken();
    const result = await this._db.find({ token });
    if (!result || result.length === 0) {
      return null;
    }
    const sessionObject = Serializer.serializeSession(session);
    await this._resultsDatabase.loadDatabase(token);

    await this._testsDatabase.loadDatabase(token);
    const tests = {};
    const { COMPLETED, ABORTED } = Session;
    if (session.getStatus() !== COMPLETED && session.getStatus() !== ABORTED) {
      const { pending_tests, running_tests, completed_tests } = sessionObject;
      tests.pending_tests = pending_tests;
      tests.running_tests = running_tests;
      tests.completed_tests = completed_tests;
    }
    const { malfunctioning_tests } = sessionObject;
    tests.malfunctioning_tests = malfunctioning_tests;
    await this._testsDatabase.updateTests(token, tests);

    delete sessionObject.completed_tests;
    delete sessionObject.running_tests;
    delete sessionObject.pending_tests;
    delete sessionObject.malfunctioning_tests;
    await this._db.update({ token }, sessionObject);
  }

  async deleteSession(token) {
    return this._queueSessionsAccess(() => this._deleteSession(token));
  }

  async _deleteSession(token) {
    const sessionDataStore = this._db;
    await sessionDataStore.remove({ token }, true);
    await this._testsDatabase.deleteTests(token);
    await this._resultsDatabase.deleteResults(token);
  }

  async findTokens(fragment) {
    return this._queueSessionsAccess(() => this._findTokens(fragment), {
      group: READ_JOB_GROUP
    });
  }

  async _findTokens(fragment) {
    const results = await this._db.find({
      token: new RegExp("^" + fragment)
    });
    return results.map(result => result.token);
  }
}

module.exports = SessionsDatabase;