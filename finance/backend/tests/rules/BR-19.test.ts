import { describe, expect, it } from 'vitest';
import { docNumberKey } from '../../src/lib/bill';

// BR-19 Duplicate vendor bill: same vendor + same document number + same FY is blocked,
// ignoring case and spaces. (The database check is in acceptance B6.)
describe('BR-19 duplicate key', () => {
  it('ignores case and spaces', () => {
    expect(docNumberKey(' pi 0037 ')).toBe('PI0037');
    expect(docNumberKey('PI0037')).toBe('PI0037');
    expect(docNumberKey('INV/26-27/040')).toBe('INV/26-27/040');
  });
});
