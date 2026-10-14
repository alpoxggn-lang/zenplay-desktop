import { TestBed } from '@angular/core/testing';
import { ZenPlayProfileService } from './zenplay-profile.service';

describe('ZenPlayProfileService', () => {
    beforeEach(() => {
        localStorage.clear();
        TestBed.configureTestingModule({ providers: [ZenPlayProfileService] });
    });

    it('requires a local profile and restores the selected profile', () => {
        const service = TestBed.inject(ZenPlayProfileService);
        const profile = service.addAndSelect('  Sala  ');

        expect(profile?.name).toBe('Sala');
        expect(service.selectedProfile()?.id).toBe(profile?.id);

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({ providers: [ZenPlayProfileService] });
        expect(
            TestBed.inject(ZenPlayProfileService).selectedProfile()?.name
        ).toBe('Sala');
    });

    it('clears only the active selection when login must choose a profile', () => {
        const service = TestBed.inject(ZenPlayProfileService);
        service.addAndSelect('Principal');

        service.requireSelection();

        expect(service.profiles()).toHaveLength(1);
        expect(service.selectedProfile()).toBeNull();
    });

    it('never selects an unknown profile', () => {
        const service = TestBed.inject(ZenPlayProfileService);

        expect(service.select('missing')).toBe(false);
        expect(service.selectedProfile()).toBeNull();
    });

    it('renames a profile and persists the updated name', () => {
        const service = TestBed.inject(ZenPlayProfileService);
        const profile = service.addAndSelect('Principal');

        expect(service.rename(profile?.id ?? '', '  Familia  ')?.name).toBe(
            'Familia'
        );

        TestBed.resetTestingModule();
        TestBed.configureTestingModule({ providers: [ZenPlayProfileService] });
        expect(TestBed.inject(ZenPlayProfileService).profiles()[0]?.name).toBe(
            'Familia'
        );
    });

    it('removes a profile and clears its active selection', () => {
        const service = TestBed.inject(ZenPlayProfileService);
        const profile = service.addAndSelect('Infantil');

        expect(service.remove(profile?.id ?? '')).toBe(true);
        expect(service.profiles()).toEqual([]);
        expect(service.selectedProfile()).toBeNull();
        expect(service.remove(profile?.id ?? '')).toBe(false);
    });
});
