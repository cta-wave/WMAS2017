from __future__ import absolute_import
import os
import shutil
import re
import json

from .results_comparator import ResultsComparator
from ..utils.user_agent_parser import parse_user_agent, abbreviate_browser_name
from ..utils.serializer import serialize_session


class ResultsManager(object):
    def initialize(
        self, 
        results_directory_path,
        sessions_manager,
        tests_manager,
        database
    ):
        self._results_directory_path = results_directory_path
        self._sessions_manager = sessions_manager
        self._tests_manager = tests_manager
        self._database = database
        self._results_comparator = ResultsComparator(results_manager=self)
        self.read_common_passed_tests = self._results_comparator.read_common_passed_tests

    def create_result(self, token, data):
        result = self.prepare_result(data)
        test = result[u"test"]

        session = self._sessions_manager.read_session(token)

        if session is None: return
        if not self._sessions_manager.test_in_session(test, session): return
        if self._sessions_manager.is_test_complete(test, session): return
        self._tests_manager.complete_test(test, session)
        self._database.create_result(token, result)

        api = ""
        for part in test.split(u"/"):
            if part is not u"":
                api = part
                break
        if not self._sessions_manager.is_api_complete(api, session): return
        self.save_api_results(token, api)
        self.generate_report(token, api)

        test_files_count = session.test_files_count
        apis = list(test_files_count.keys())
        all_apis_complete = True
        for api in apis:
            if not self._sessions_manager.is_api_complete(api, session):
                all_apis_complete = False
        if not all_apis_complete: return
        self._sessions_manager.complete_session(token)
        self.create_info_file(session)

    def read_results(self, token, filter_path=None):
        filter_api = None
        if filter_path is not None:
            filter_api = next((p for p in filter_path.split(u"/") if p is not None), None)
        results = self._database.read_results(token)

        results_per_api = {}

        for result in results:
            api = next((p for p in result[u"test"].split(u"/") if p is not u""), None)
            if filter_api is not None and api.lower() != filter_api.lower(): continue
            if filter_path is not None:
                pattern = re.compile(u"^" + filter_path.replace(u".", u""))
                if pattern.match(result[u"test"].replace(u".", u"")) is None: continue
            if api not in results_per_api: results_per_api[api] = []
            results_per_api[api].append(result)

        return results_per_api

    def read_flattened_results(self, token):
        results = self.read_results(token)
        flattened_results = {}

        for api in results:
            if api not in flattened_results:
                flattened_results[api] = {
                    u"pass": 0,
                    u"fail": 0,
                    u"timeout": 0,
                    u"not_run": 0
                }

            for result in results[api]:
                if u"subtests" not in result:
                    if result[u"status"] == u"OK":
                        flattened_results[api][u"pass"] += 1
                        continue
                    if result[u"status"] == u"ERROR":
                        flattened_results[api][u"fail"] += 1
                        continue
                    if result[u"status"] == u"TIMEOUT":
                        flattened_results[api][u"timeout"] += 1
                        continue
                    if result[u"status"] == u"NOTRUN":
                        flattened_results[api][u"not_run"] += 1
                        continue
                for test in result[u"subtests"]:
                    if test[u"status"] == u"PASS":
                        flattened_results[api][u"pass"] += 1
                        continue
                    if test[u"status"] == u"FAIL":
                        flattened_results[api][u"fail"] += 1
                        continue
                    if test[u"status"] == u"TIMEOUT":
                        flattened_results[api][u"timeout"] += 1
                        continue
                    if test[u"status"] == u"NOTRUN":
                        flattened_results[api][u"not_run"] += 1
                        continue

        return flattened_results

    def delete_results(self, token):
        results_directory = os.path.join(self._results_directory_path, token)
        if not os.path.isdir(results_directory): return
        shutil.rmtree(results_directory)

    def prepare_result(self, result):
        harness_status_map = {
            0: u"OK",
            1: u"ERROR",
            2: u"TIMEOUT",
            3: u"NOTRUN",
            u"OK": u"OK",
            u"ERROR": u"ERROR",
            u"TIMEOUT": u"TIMEOUT",
            u"NOTRUN": u"NOTRUN"
        }

        subtest_status_map = {
            0: u"PASS",
            1: u"FAIL",
            2: u"TIMEOUT",
            3: u"NOTRUN",
            u"PASS": u"PASS",
            u"FAIL": u"FAIL",
            u"TIMEOUT": u"TIMEOUT",
            u"NOTRUN": u"NOTRUN"
        }

        if u"tests" in result:
            for test in result[u"tests"]:
                test[u"status"] = subtest_status_map[test[u"status"]]
                if u"stack" in test: del test[u"stack"]
            result[u"subtests"] = result[u"tests"]
            del result[u"tests"]

        if u"stack" in result: del result[u"stack"]
        result[u"status"] = harness_status_map[result[u"status"]]

        return result

    def get_json_path(self, token, api):
        session = self._sessions_manager.read_session(token)
        api_directory = os.path.join(self._results_directory_path, token, api)
        
        browser = parse_user_agent(session.user_agent)
        abbreviation = abbreviate_browser_name(browser[u"name"])
        version = browser[u"version"]
        if u"." in version:
            version = version.split(u".")[0]
        version = version.zfill(2)
        file_name = abbreviation + version + ".json"

        return os.path.join(api_directory, file_name)

    def save_api_results(self, token, api):
        results = self.read_results(token)
        api_results = { "results": results[api] }
        session = self._sessions_manager.read_session(token)

        self._ensure_results_directory_existence(api, token, session)

        file_path = self.get_json_path(token, api)

        file = open(file_path, "w+")
        file.write(json.dumps(api_results, indent=4, separators=(',', ': ')))
        file.close()

    def _ensure_results_directory_existence(self, api, token, session):
        directory = os.path.join(self._results_directory_path, token, api)
        if not os.path.exists(directory):
            os.makedirs(directory)

        self.create_info_file(session)
    
    def generate_report(self, token, api):
        print u"TODO: IMPLEMENT generate_report"

    def create_info_file(self, session):
        token = session.token
        info_file_path = os.path.join(
            self._results_directory_path,
            token,
            "info.json"
        )
        info = serialize_session(session)
        del info[u"running_tests"]
        del info[u"pending_tests"]
        del info[u"completed_tests"]

        file_content = json.dumps(info, indent=2)
        file = open(info_file_path, "w+")
        file.write(file_content)
        file.close()