#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const [consumerPath, dependencyName, dependencyPath] = process.argv.slice(2);
if (!consumerPath || !dependencyName || !dependencyPath) throw new Error("consumer, dependency name, and dependency package are required");
const consumer = JSON.parse(await readFile(consumerPath, "utf8"));
const dependency = JSON.parse(await readFile(dependencyPath, "utf8"));
const specifier = consumer.dependencies?.[dependencyName];
if (specifier !== "workspace:*") throw new Error(`${dependencyName} must use workspace:*`);
if (typeof dependency.version !== "string" || dependency.version.length === 0) throw new Error(`${dependencyName} package version is missing`);
process.stdout.write(dependency.version);
