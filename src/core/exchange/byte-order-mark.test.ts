import { describe, expect, it } from 'vitest';
import { stripLeadingByteOrderMark } from './byte-order-mark';

describe('stripLeadingByteOrderMark', () => {
  it('removes one byte order mark at the start only', () => {
    expect(stripLeadingByteOrderMark('﻿{}')).toBe('{}');
    expect(stripLeadingByteOrderMark('﻿﻿{}')).toBe('﻿{}');
    expect(stripLeadingByteOrderMark('{﻿}')).toBe('{﻿}');
    expect(stripLeadingByteOrderMark(' ﻿{}')).toBe(' ﻿{}');
    expect(stripLeadingByteOrderMark('')).toBe('');
  });
});
