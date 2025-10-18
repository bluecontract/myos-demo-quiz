#!/usr/bin/env node
import 'source-map-support/register.js';
import { App } from 'aws-cdk-lib';
import { MyosQuizStack } from '../lib/MyosQuizStack';

const app = new App();
const stage = app.node.tryGetContext('stage') ?? process.env.STAGE ?? 'dev';

new MyosQuizStack(app, `MyosQuizStack-${stage}`, {
  stage
});
