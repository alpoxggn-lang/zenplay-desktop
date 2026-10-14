import {
    getInitialLanguage,
    PREFERRED_LANGUAGE_STORAGE_KEY,
} from './app.config';

describe('ZenPlay initial language', () => {
    afterEach(() => localStorage.clear());

    it('uses Spanish on a first launch', () => {
        expect(getInitialLanguage()).toBe('es');
    });

    it('respects a supported language saved by the user', () => {
        localStorage.setItem(PREFERRED_LANGUAGE_STORAGE_KEY, 'fr');

        expect(getInitialLanguage()).toBe('fr');
    });

    it('falls back to Spanish for an unsupported saved value', () => {
        localStorage.setItem(PREFERRED_LANGUAGE_STORAGE_KEY, 'unsupported');

        expect(getInitialLanguage()).toBe('es');
    });
});
