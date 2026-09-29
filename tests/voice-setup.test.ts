import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('manually managed local voice service', () => {
  it('pins the CUDA image, binds only loopback, and retains a named model cache with GPU access', () => {
    const compose = read('deploy/compose.voice.yaml');
    expect(compose).toContain('ghcr.io/speaches-ai/speaches@sha256:6ec12ebf890a17e0d4b242a8ba9e0eb1fb836e60e8a3c857aea9838d541579ac');
    expect(compose).toContain('127.0.0.1:8000:8000');
    expect(compose).toMatch(/volumes:\s*\n\s+-\s*voice-model-cache:.*\.cache\/huggingface\/hub/);
    expect(compose).toMatch(/volumes:\s*\n\s*voice-model-cache:/);
    expect(compose).toMatch(/driver:\s*nvidia/);
    expect(compose).toMatch(/capabilities:\s*\[gpu\]/);
  });

  it('exposes only explicit lifecycle verbs and installs only approved models after registry checks', () => {
    const script = read('scripts/voice.ps1');
    expect(script).toMatch(/param\s*\(\s*\[ValidateSet\('start','stop','status','models'\)\]\s*\[string\]\$Action\s*\)/);
    expect(script).toContain('Systran/faster-whisper-small');
    expect(script).toContain('speaches-ai/Kokoro-82M-v1.0-ONNX');
    expect(script).toContain('/v1/registry');
    expect(script).toContain('/v1/models');
    expect(script).toContain('127.0.0.1:8000');
    expect(script.indexOf('foreach ($id in $approvedModels)')).toBeGreaterThan(script.indexOf('/v1/registry'));
    expect(script.indexOf('Invoke-RestMethod -Uri "$baseUrl/v1/models/$id" -Method Post')).toBeGreaterThan(script.indexOf('foreach ($id in $approvedModels)'));
    expect(script).toContain('was not found after installation');
    expect(script).not.toMatch(/large-v3|small\.en|latest-cuda|Start-Job|Register-ScheduledTask/);
  });
});
