import "./init";

import Debug from "debug";
import { CurrentsRunParameters } from "../types";
import { createRun } from "./api";
import { cutInitialOutput } from "./capture";
import { getCI } from "./ciProvider";
import {
  getMergedConfig,
  isOffline,
  preprocessParams,
  validateParams,
} from "./config";
import { runBareCypress } from "./cypress";
import { getGitInfo } from "./git";
import { setAPIBaseUrl, setRunId } from "./httpClient";
import { bold, divider, info, spacer, title } from "./log";
import { getPlatform } from "./platform";
import { pubsub } from "./pubsub";
import { summarizeTestResults, summaryTable } from "./results";
import {
  createReportTaskSpec,
  getExecutionStateResults,
  reportTasks,
  runTillDoneOrCancelled,
  setSpecAfter,
  setSpecBefore,
} from "./runner";
import { getSpecFiles } from "./specMatcher";
import { startWSS } from "./ws";

const debug = Debug("currents:run");

export async function run(params: CurrentsRunParameters = {}) {
  debug("run params %o", params);
  params = preprocessParams(params);
  debug("params after preprocess %o", params);

  if (isOffline(params)) {
    info(`Skipping cloud orchestration because --record is set to false`);
    return runBareCypress(params);
  }
  const validatedParams = validateParams(params);
  setAPIBaseUrl(validatedParams.cloudServiceUrl);

  const {
    recordKey,
    projectId,
    group,
    parallel,
    ciBuildId,
    tag,
    testingType,
    batchSize,
    autoCancelAfterFailures,
  } = validatedParams;

  const config = await getMergedConfig(validatedParams);
  const { specs, specPattern } = await getSpecFiles({
    config,
    params: validatedParams,
  });

  if (specs.length === 0) {
    return;
  }

  const platform = await getPlatform({
    config,
    browser: validatedParams.browser,
  });

  divider();

  info("Discovered %d spec files", specs.length);
  info(
    `Tags: ${tag.length > 0 ? tag.join(",") : false}; Group: ${
      group ?? false
    }; Parallel: ${parallel ?? false}; Batch Size: ${batchSize}`
  );
  info("Connecting to cloud orchestration service...");

  const run = await createRun({
    ci: getCI(ciBuildId),
    specs: specs.map((spec) => spec.relative),
    commit: await getGitInfo(config.projectRoot),
    group,
    platform,
    parallel: parallel ?? false,
    ciBuildId,
    projectId,
    recordKey,
    specPattern: [specPattern].flat(2),
    tags: tag,
    testingType,
    batchSize,
    autoCancelAfterFailures,
  });

  setRunId(run.runId);
  info("🎥 Run URL:", bold(run.runUrl));
  cutInitialOutput();

  await startWSS();
  listenToSpecEvents();

  await runTillDoneOrCancelled(
    {
      runId: run.runId,
      groupId: run.groupId,
      machineId: run.machineId,
      platform,
      specs,
    },
    validatedParams
  );

  divider();

  await Promise.allSettled(reportTasks);
  const _summary = summarizeTestResults(getExecutionStateResults(), config);

  title("white", "Cloud Run Finished");
  console.log(summaryTable(_summary));
  info("🏁 Recorded Run:", bold(run.runUrl));

  spacer();
  if (_summary.status === "finished") {
    return {
      ..._summary,
      runUrl: run.runUrl,
    };
  }
  return _summary;
}

function listenToSpecEvents() {
  pubsub.on("before:spec", async ({ spec }: { spec: Cypress.Spec }) =>
    setSpecBefore(spec.relative)
  );

  pubsub.on(
    "after:spec",
    async ({ spec, results }: { spec: Cypress.Spec; results: any }) => {
      setSpecAfter(spec.relative, results);
      createReportTaskSpec(spec.relative);
    }
  );
}
