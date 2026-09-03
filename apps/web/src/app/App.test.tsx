// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '../test/setup';
import { describe, expect, test } from 'vitest';
import { App } from './App';

describe('App', () => {
  test('renders the studio shell', () => {
    render(<App />);
    expect(screen.getByText('SOVARA Studio')).toBeInTheDocument();
  });
});
