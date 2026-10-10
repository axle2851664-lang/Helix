import { describe, expect, it } from 'vitest';
import { editIntent, generationIntent } from './generate.js';
import { imageIntent } from './query.js';

describe('generationIntent', () => {
  it.each([
    ['create an image of a futuristic AI core', 'a futuristic AI core'],
    ['generate a picture of a cat', 'a cat'],
    ['make me an image of a sunset', 'a sunset'],
    ['draw a diagram of the architecture', 'the architecture'],
    ['design a logo for my project', 'my project'],
    ['render an illustration showing two moons', 'two moons'],
    ['create an image', ''],
  ])('%s asks for an image to be made', (phrase, prompt) => {
    expect(generationIntent(phrase)).toEqual({ prompt });
  });

  /**
   * The distinction the whole module exists for. Searching and making are
   * different requests, and Havoc can only do one of them - so a search must
   * never be read as a request to generate, or a working feature starts
   * answering "I cannot".
   */
  it.each([
    'show me pictures of mountains',
    'find me images of a cat',
    'search the web for pictures of bridges',
  ])('%s is a search, not a generation', (phrase) => {
    expect(generationIntent(phrase)).toBeNull();
    expect(imageIntent(phrase)).not.toBeNull();
  });

  /** A making verb alone is far too broad. */
  it.each([
    'create a note about the supplier',
    'draw up a plan for the week',
    'make a timer for five minutes',
    'the image is blurry',
    'generate some ideas',
  ])('%s is not an image request', (phrase) => {
    expect(generationIntent(phrase)).toBeNull();
  });
});

describe('editIntent', () => {
  it.each([
    'edit this image to remove the sky',
    'upscale that photo',
    'change the picture to black and white',
  ])('%s is an edit', (phrase) => {
    expect(editIntent(phrase)).toBe(true);
  });

  it.each(['edit my note', 'change the timer', 'show me pictures of cats'])(
    '%s is not an image edit',
    (phrase) => {
      expect(editIntent(phrase)).toBe(false);
    },
  );
});
