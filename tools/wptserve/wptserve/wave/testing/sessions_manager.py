from __future__ import division
from __future__ import absolute_import
import uuid
import time
import os
import json

from threading import Timer

from .test_loader import AUTOMATIC, MANUAL
from ..data.session import Session, PENDING, PAUSED, RUNNING, ABORTED, COMPLETED
from ..utils.user_agent_parser import parse_user_agent
from .event_dispatcher import STATUS_EVENT, RESUME_EVENT
from ..data.exceptions.not_found_exception import NotFoundException
from ..utils.deserializer import deserialize_session

DEFAULT_TEST_TYPES = [AUTOMATIC, MANUAL]
DEFAULT_TEST_PATHS = [u"/"]
DEFAULT_TEST_AUTOMATIC_TIMEOUT = 60000
DEFAULT_TEST_MANUAL_TIMEOUT = 300000


class SessionsManager(object):
    def initialize(self, test_loader, event_dispatcher, tests_manager, results_directory, results_manager):
        self._test_loader = test_loader
        self._sessions = {}
        self._expiration_timeout = None
        self._event_dispatcher = event_dispatcher
        self._tests_manager = tests_manager
        self._results_directory = results_directory
        self._results_manager = results_manager

    def create_session(
        self,
        tests={},
        types=None,
        timeouts={},
        reference_tokens=[],
        webhook_urls=[],
        user_agent=u"",
        labels=[],
        expiration_date=None
    ):
        if u"include" not in tests:
            tests[u"include"] = DEFAULT_TEST_PATHS
        if u"exclude" not in tests:
            tests[u"exclude"] = []
        if u"automatic" not in timeouts:
            timeouts[u"automatic"] = DEFAULT_TEST_AUTOMATIC_TIMEOUT
        if u"manual" not in timeouts:
            timeouts[u"manual"] = DEFAULT_TEST_MANUAL_TIMEOUT
        if types is None:
            types = DEFAULT_TEST_TYPES

        token = unicode(uuid.uuid1())
        pending_tests = self._test_loader.get_tests(
            types,
            include_list=tests[u"include"],
            exclude_list=tests[u"exclude"],
            reference_tokens=reference_tokens)

        browser = parse_user_agent(user_agent)

        test_files_count = self._tests_manager.calculate_test_files_count(
            pending_tests
        )

        test_state = {}
        for api in test_files_count:
            test_state[api] = {
                    "pass": 0,
                    "fail": 0,
                    "timeout": 0,
                    "not_run": 0,
                    "total": test_files_count[api],
                    "complete": 0,
            }

        session = Session(
            token=token,
            tests=tests,
            user_agent=user_agent,
            browser=browser,
            types=types,
            timeouts=timeouts,
            pending_tests=pending_tests,
            running_tests={},
            test_state=test_state,
            status=PENDING,
            reference_tokens=reference_tokens,
            webhook_urls=webhook_urls,
            labels=labels,
            expiration_date=expiration_date
        )
        
        self._push_to_cache(session)
        if expiration_date is not None:
            self._set_expiration_timer()

        return session

    def read_session(self, token):
        if token is None: return None
        session = self._read_from_cache(token)
        if session is None:
            session = self.load_session(token)
            if session is not None:
                self._push_to_cache(session)
        return session

    def read_public_sessions(self):
        self.load_all_sessions()
        session_tokens = []
        for token in self._sessions:
            session = self._sessions[token]
            if not session.is_public: continue
            session_tokens.append(token)

        return session_tokens

    def update_session(self, session):
        self._push_to_cache(session)

    def update_session_configuration(
        self, token, tests, types, timeouts, reference_tokens, webhook_urls
    ):
        session = self.read_session(token)
        if session is None: raise NotFoundException(u"Could not find session")
        if session.status != PENDING:
            return

        if tests is not None:
            if u"include" not in tests:
                tests[u"include"] = session.tests[u"include"]
            if u"exclude" not in tests:
                tests[u"exclude"] = session.tests[u"exclude"]
            if reference_tokens is None:
                reference_tokens = session.reference_tokens
            if types is None:
                types = session.types
            pending_tests = self._test_loader.get_tests(
                include_list=tests[u"include"],
                exclude_list=tests[u"exclude"],
                reference_tokens=reference_tokens,
                types=types
            )
            session.pending_tests = pending_tests
            session.tests = tests
            test_files_count = self._tests_manager.calculate_test_files_count(
                pending_tests)
            test_state = {}
            for api in test_files_count:
                test_state[api] = {
                        "pass": 0,
                        "fail": 0,
                        "timeout": 0,
                        "not_run": 0,
                        "total": test_files_count[api],
                        "complete": 0,
                }
            session.test_state = test_state
            
        if types is not None:
            session.types = types
        if timeouts is not None:
            if AUTOMATIC not in timeouts:
                timeouts[AUTOMATIC] = session.timeouts[AUTOMATIC]
            if MANUAL not in timeouts:
                timeouts[MANUAL] = session.timeouts[MANUAL]
            session.timeouts = timeouts
        if reference_tokens is not None:
            session.reference_tokens = reference_tokens
        if webhook_urls is not None:
            session.webhook_urls = webhook_urls

        self._push_to_cache(session)
        return session

    def update_labels(self, token, labels):
        if token is None or labels is None:
            return
        session = self.read_session(token)
        if session.is_public:
            return
        session.labels = labels
        self._push_to_cache(session)

    def delete_session(self, token):
        session = self.read_session(token)
        if session is None: return
        if session.is_public is True: return
        del self._sessions[token]

    def add_session(self, session):
        if session is None: return
        self._push_to_cache(session)

    def load_all_sessions(self):
        if not os.path.isdir(self._results_directory): return
        tokens = os.listdir(self._results_directory)
        for token in tokens:
            self.load_session(token)

    def load_session(self, token):
        result_directory = os.path.join(self._results_directory, token)
        if not os.path.isdir(result_directory): return None
        info_file = os.path.join(result_directory, "info.json")
        if not os.path.isfile(info_file): return None

        file = open(info_file, "r")
        info_data = file.read()
        file.close()
        parsed_info_data = json.loads(info_data)

        session = deserialize_session(parsed_info_data)

        if session.status == COMPLETED or session.status == ABORTED:
            self._push_to_cache(session)
            return session

        pending_tests = self._test_loader.get_tests(
            session.types,
            include_list=session.tests[u"include"],
            exclude_list=session.tests[u"exclude"],
            reference_tokens=session.reference_tokens
        )

        last_completed_test = session.last_completed_test
        pending_tests = self._tests_manager.skip_to(pending_tests, last_completed_test)

        session.pending_tests = pending_tests
        self._push_to_cache(session)
        return session
        
    def _push_to_cache(self, session):
        self._sessions[session.token] = session

    def _read_from_cache(self, token):
        if token not in self._sessions: return None
        return self._sessions[token]

    def _set_expiration_timer(self):
        expiring_sessions = self._read_expiring_sessions()
        if len(expiring_sessions) == 0: return

        next_session = expiring_sessions[0]
        for session in expiring_sessions:
            if next_session.expiration_date > session.expiration_date:
                next_session = session

        if self._expiration_timeout is not None:
            self._expiration_timeout.cancel()

        timeout = next_session.expiration_date / 1000.0 - int(time.time())
        if timeout < 0: timeout = 0

        def handle_timeout(self):
            self._delete_expired_sessions()
            self._set_expiration_timer()

        self._expiration_timeout = Timer(timeout, handle_timeout, [self])
        self._expiration_timeout.start()

    def _delete_expired_sessions(self):
        expiring_sessions = self.read_expiring_sessions()
        now = int(time.time())

        for session in expiring_sessions:
            if session.expiration_date / 1000.0 < now:
                self.delete_session(session.token)

    def _read_expiring_sessions(self):
        expiring_sessions = []
        for token in self._sessions:
            session = self._sessions[token]
            if session.expiration_date is None: continue
            expiring_sessions.append(session)
        return expiring_sessions

    def start_session(self, token):
        session = self.read_session(token)
        
        if session is None:
            return

        if session.status != PENDING and session.status != PAUSED:
            return

        if session.status == PENDING:
            session.date_started = int(time.time()) * 1000
            session.expiration_date = None

        session.status = RUNNING
        self.update_session(session)

        self._event_dispatcher.dispatch_event(
            token,
            event_type=STATUS_EVENT,
            data=session.status
        )

    def pause_session(self, token):
        session = self.read_session(token)
        if session.status != RUNNING: return
        session.status = PAUSED
        self.update_session(session)
        self._event_dispatcher.dispatch_event(
            token, 
            event_type=STATUS_EVENT, 
            data=session.status
        )
        self._results_manager.persist_session(session)

    def stop_session(self, token):
        session = self.read_session(token)
        if session.status == ABORTED or session.status == COMPLETED: return
        session.status = ABORTED
        session.date_finished = time.time() * 1000
        self.update_session(session)
        self._event_dispatcher.dispatch_event(
            token,
            event_type=STATUS_EVENT,
            data=session.status
        )

    def resume_session(self, token, resume_token):
        session = self.read_session(token)
        if session.status != PENDING: return
        self._event_dispatcher.dispatch_event(
            token,
            event_type=RESUME_EVENT,
            data=resume_token
        )
        self.delete_session(token)

    def complete_session(self, token):
        session = self.read_session(token)
        if session.status == COMPLETED or session.status == ABORTED: return
        session.status = COMPLETED
        session.date_finished = time.time() * 1000
        self.update_session(session)
        self._event_dispatcher.dispatch_event(
            token,
            event_type=STATUS_EVENT,
            data=session.status
        )

    def test_in_session(self, test, session):
        return self._test_list_contains_test(test, session.pending_tests) \
            or self._test_list_contains_test(test, session.running_tests) 

    def is_test_complete(self, test, session):
        return not self._test_list_contains_test(test, session.pending_tests) \
            and not self._test_list_contains_test(test, session.running_tests)

    def is_test_running(self, test, session):
        return self._test_list_contains_test(test, session.running_tests)

    def _test_list_contains_test(self, test, test_list):
        for api in list(test_list.keys()):
            if test in test_list[api]:
                return True
        return False

    def is_api_complete(self, api, session):
        return api not in session.pending_tests and api not in session.running_tests

    def find_token(self, fragment):
        if len(fragment) < 8: return None
        tokens = []
        for token in self._sessions:
            if token.beginswith(fragment): tokens.append(token)
        if len(tokens) != 1: return None
        return tokens[0]
