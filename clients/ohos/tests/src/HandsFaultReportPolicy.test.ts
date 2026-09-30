import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  capturedCrashBuild,
  crashTicketVersions,
  describeFaultSignal,
  faultBuildIdentity,
} from '../../hands/src/main/ets/HandsFaultReportPolicy.ts';

test('native signal title uses signo and labels si_code', () => {
  const described = describeFaultSignal({ signo: 11, code: 2, address: '0x3389a10' });
  assert.equal(described, '11, code 2');
  assert.notEqual(described, '2');
});

test('legacy signal object still reports the signal number', () => {
  assert.equal(describeFaultSignal({ signal: 11, name: 'SIGSEGV' }), 'SIGSEGV 11');
  assert.equal(describeFaultSignal(11), '11');
  assert.equal(describeFaultSignal('SIGSEGV'), 'SIGSEGV');
});

test('si_code alone is not reported as the signal number', () => {
  assert.equal(describeFaultSignal({ code: 2 }), '');
  assert.equal(describeFaultSignal(undefined), '');
});

test('fault log version wins over the uploading process and over bundle_version', () => {
  const faultText = [
    'Module name:com.example.raft',
    'Version:1.0.0-kuikly228',
    'VersionCode:10000971',
    'Reason:Signal:SIGSEGV(SEGV_ACCERR)@0x3389a10',
  ].join('\n');
  assert.deepEqual(faultBuildIdentity('1.0.0-raft8baseline', faultText), {
    versionName: '1.0.0-kuikly228',
    versionCode: 10000971,
  });
});

test('bundle_version is only the version-name fallback', () => {
  assert.deepEqual(faultBuildIdentity('1.0.0-kuikly228', ''), {
    versionName: '1.0.0-kuikly228',
    versionCode: null,
  });
  assert.equal(faultBuildIdentity('', 'no header'), null);
});

test('a captured crash does not inherit the build that uploads it', () => {
  const live = { versionName: '1.0.0-raft8baseline', versionCode: 10000972 };
  assert.deepEqual(
    crashTicketVersions(
      { versionName: '1.0.0-kuikly228', versionCode: 10000971 },
      live,
    ),
    { versionName: '1.0.0-kuikly228', versionCode: 10000971 },
  );
  assert.deepEqual(
    crashTicketVersions({ versionName: '1.0.0-kuikly228', versionCode: null }, live),
    { versionName: '1.0.0-kuikly228', versionCode: null },
  );
  assert.deepEqual(crashTicketVersions(null, live), live);
});

test('sidecars written before build capture keep the live install', () => {
  assert.equal(
    capturedCrashBuild(
      { versionName: '', versionCode: null },
      { versionName: false, versionCode: false },
    ),
    null,
  );
  assert.deepEqual(
    capturedCrashBuild(
      { versionName: '1.0.0-kuikly228', versionCode: null },
      { versionName: true, versionCode: true },
    ),
    { versionName: '1.0.0-kuikly228', versionCode: null },
  );
});
