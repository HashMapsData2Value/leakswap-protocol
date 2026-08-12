import {
  genPrivateSpendKey,
  genPrivateViewKey,
} from './monero-utils';

describe('monero-utils test', () => {
  it('genPrivateSpendKey & genPrivateViewKey should generate a valid 64 character hex scalars', () => {
    const key = genPrivateSpendKey();
    expect(typeof key).toBe("string");
    expect(key.length).toBe(64);


    const viewKey = genPrivateViewKey(key);
    expect(typeof viewKey).toBe("string");
    expect(viewKey.length).toBe(64);
  });
});