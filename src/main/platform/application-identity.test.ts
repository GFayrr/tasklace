import { describe, expect, it, vi } from 'vitest';
import { APPLICATION_USER_MODEL_ID, setApplicationIdentity } from './application-identity';

describe('setApplicationIdentity', () => {
  it('gives the application its identifier on Windows', () => {
    const application = { setAppUserModelId: vi.fn() };
    setApplicationIdentity('win32', application);
    expect(application.setAppUserModelId.mock.calls).toEqual([['io.github.gfayrr.tasklace']]);
    expect(APPLICATION_USER_MODEL_ID).toBe('io.github.gfayrr.tasklace');
  });

  it('leaves the other systems alone', () => {
    const application = { setAppUserModelId: vi.fn() };
    setApplicationIdentity('linux', application);
    setApplicationIdentity('darwin', application);
    expect(application.setAppUserModelId.mock.calls).toEqual([]);
  });
});
