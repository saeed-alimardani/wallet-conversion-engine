import { validate as validateUuid } from 'uuid';
import { correlationIdFromHeader } from './app.module';

describe('correlationIdFromHeader', () => {
  it('preserves a bounded caller-supplied correlation id', () => {
    expect(correlationIdFromHeader('trace-123:span_456')).toBe('trace-123:span_456');
  });

  it('uses the first value when Node supplies an array header', () => {
    expect(correlationIdFromHeader(['trace-1', 'trace-2'])).toBe('trace-1');
  });

  it.each([undefined, '', 'bad id', 'line\nbreak', `x${'a'.repeat(128)}`])(
    'replaces unsafe correlation id %p',
    (value) => {
      expect(validateUuid(correlationIdFromHeader(value))).toBe(true);
    },
  );
});
