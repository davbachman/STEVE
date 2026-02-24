/// <reference lib="webworker" />

import { analyzeEquationText } from '../math/classifier';
import type { WorkerRequest, WorkerResponse } from '../types/contracts';

const canceledByObject = new Map<string, number>();

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  if (req.type === 'cancel_jobs') {
    canceledByObject.set(req.objectId, Date.now());
    const res: WorkerResponse = { type: 'cancel_ack', jobId: req.jobId, objectId: req.objectId };
    self.postMessage(res);
    return;
  }

  if (req.type !== 'parse_and_classify') {
    return;
  }

  canceledByObject.delete(req.objectId);

  if (isCanceled(req.objectId)) {
    return;
  }

  postProgress({
    type: 'parse_progress',
    jobId: req.jobId,
    objectId: req.objectId,
    phase: 'tokenize_parse',
    progress: 0.2,
  });

  try {
    const result = analyzeEquationText(req.rawText);
    if (isCanceled(req.objectId)) {
      return;
    }
    postProgress({
      type: 'parse_progress',
      jobId: req.jobId,
      objectId: req.objectId,
      phase: 'classify',
      progress: 0.85,
    });
    const res: WorkerResponse = {
      type: 'parse_result',
      jobId: req.jobId,
      objectId: req.objectId,
      result,
    };
    self.postMessage(res);
  } catch (error) {
    const res: WorkerResponse = {
      type: 'job_error',
      jobId: req.jobId,
      objectId: req.objectId,
      message: error instanceof Error ? error.message : 'mathWorker parse error',
      recoverable: true,
    };
    self.postMessage(res);
  }
};

function isCanceled(objectId: string): boolean {
  return canceledByObject.has(objectId);
}

function postProgress(message: Extract<WorkerResponse, { type: 'parse_progress' }>): void {
  self.postMessage(message);
}

export {};
