import process from 'node:process';
import * as coreLib from '@actions/core';
import { logger as loggerLib } from './logger';

const isCI = process.env.CI === 'true';

export const core = {
  isCI,
  setFailed: (message: string): void => {
    if (isCI) {
      coreLib.setFailed(message);
    } else {
      loggerLib.error(message);
    }
  },
  getInput: (name: string): string | undefined => {
    if (isCI) {
      return coreLib.getInput(name);
    }
    return undefined;
  },
  exportVariable: (name: string, value: string): void => {
    if (isCI) {
      coreLib.exportVariable(name, value);
    }
  },
  //* Logger
  info: (message: string): void => {
    if (isCI) {
      coreLib.info(message);
    } else {
      loggerLib.info(message);
    }
  },
  warning: (message: string): void => {
    if (isCI) {
      coreLib.warning(message);
    } else {
      loggerLib.warn(message);
    }
  },
  error: (message: string): void => {
    if (isCI) {
      coreLib.error(message);
    } else {
      loggerLib.error(message);
    }
  },
  debug: (message: string): void => {
    if (isCI) {
      coreLib.debug(message);
    } else {
      loggerLib.debug(message);
    }
  },
  log: (message: string): void => {
    if (isCI) {
      coreLib.info(message);
    } else {
      loggerLib.log(message);
    }
  },
  success: (message: string): void => {
    if (isCI) {
      coreLib.info(message);
    } else {
      loggerLib.success(message);
    }
  },
};
