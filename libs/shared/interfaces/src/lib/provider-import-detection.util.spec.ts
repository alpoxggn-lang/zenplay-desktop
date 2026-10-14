import {
    detectProviderImportCandidates,
    ProviderImportCandidate,
} from './provider-import-detection.util';

describe('detectProviderImportCandidates', () => {
    const only = (
        candidates: ProviderImportCandidate[],
        kind: ProviderImportCandidate['kind']
    ) => candidates.filter((candidate) => candidate.kind === kind);

    it('returns nothing for empty or blank input', () => {
        expect(detectProviderImportCandidates('')).toEqual([]);
        expect(detectProviderImportCandidates('   \n\t ')).toEqual([]);
        expect(
            detectProviderImportCandidates(undefined as unknown as string)
        ).toEqual([]);
    });

    it('returns nothing for prose without credentials or links', () => {
        expect(
            detectProviderImportCandidates(
                'Hello! Thanks for your purchase, enjoy the service.'
            )
        ).toEqual([]);
    });

    describe('xtream detection', () => {
        it('detects a get.php URL and mines the credentials from its query', () => {
            const candidates = detectProviderImportCandidates(
                'Your playlist: http://tv.example:8080/get.php?username=alice&password=s3cret&type=m3u_plus&output=ts'
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                confidence: 'high',
                serverUrl: 'http://tv.example:8080',
                username: 'alice',
                password: 's3cret',
                suggestedTitle: 'tv.example',
            });
        });

        it('offers a get.php link with credentials as a low-ranked plain M3U too', () => {
            const candidates = detectProviderImportCandidates(
                'http://tv.example:8080/get.php?username=alice&password=s3cret&type=m3u_plus'
            );

            const m3u = only(candidates, 'm3u-url');
            expect(m3u).toHaveLength(1);
            expect(m3u[0].confidence).toBe('low');
            expect(m3u[0].url).toBe(
                'http://tv.example:8080/get.php?username=alice&password=s3cret&type=m3u_plus'
            );
        });

        it('combines a bare player_api.php URL with labeled credentials', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Server: http://panel.example/player_api.php',
                    'Username: bob',
                    'Password: hunter2',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                confidence: 'high',
                serverUrl: 'http://panel.example',
                username: 'bob',
                password: 'hunter2',
            });
        });

        it('leans xtream for labeled username+password with a labeled host and port', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Host: labeled.example',
                    'Port: 8080',
                    'User: fixtureUserLabeled',
                    'Pass: fixturePassLabeled',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                confidence: 'medium',
                serverUrl: 'http://labeled.example:8080',
                username: 'fixtureUserLabeled',
                password: 'fixturePassLabeled',
                suggestedTitle: 'labeled.example',
            });
        });

        it('still proposes xtream from a credential pair with no server at all', () => {
            const candidates = detectProviderImportCandidates(
                'login: dave\nпароль: qwerty123'
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].confidence).toBe('low');
            expect(xtream[0].username).toBe('dave');
            expect(xtream[0].password).toBe('qwerty123');
            expect(xtream[0].serverUrl).toBeUndefined();
        });

        it('understands Russian labels', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Сервер: http://ru.example:2500',
                    'Логин: ivan',
                    'Пароль: secret42',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://ru.example:2500',
                username: 'ivan',
                password: 'secret42',
            });
        });

        it('reads decorated reseller messages (math-alphabet labels, arrow separators)', () => {
            // Synthetic fixture shape: labels dressed in Unicode math monospace to
            // slip past chat spam filters, ➤ as the separator, ├◉ decoration.
            const candidates = detectProviderImportCandidates(
                [
                    '◉𝙿𝙾𝚁𝚃𝙰𝙻➤ http://decorated.example:80/',
                    '├◉𝚄𝚂𝙴𝚁➤ fixtureUserDecorated',
                    '├◉𝙿𝙰𝚂𝚂➤ fixturePassDecorated',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://decorated.example',
                username: 'fixtureUserDecorated',
                password: 'fixturePassDecorated',
            });
        });

        it.each([
            ['arrow', 'USER ➤ carol\nPASS ➤ pa55'],
            ['triangle', 'User ► carol\nPass ► pa55'],
            ['unicode arrow', 'login → carol\npassword → pa55'],
            ['ascii gt', 'USER > carol\nPASS > pa55'],
            ['spaced dash', 'User - carol\nPass - pa55'],
        ])(
            'accepts the %s label separator',
            (_variant, message) => {
                const xtream = only(
                    detectProviderImportCandidates(message),
                    'xtream'
                );
                expect(xtream).toHaveLength(1);
                expect(xtream[0].username).toBe('carol');
                expect(xtream[0].password).toBe('pa55');
            }
        );

        it('folds negative-circled font labels (🅤🅢🅔🅡 / 🅟🅐🅢🅢) and reads the get.php line', () => {
            // Sanitized synthetic fixture: negative-circled capitals NFKC does
            // not fold, ➤➤ separators, and a "🅜➌🅤 🅛🅘🅢🅣" (M3U LIST) get.php
            // line whose query is the authoritative credential source.
            const candidates = detectProviderImportCandidates(
                [
                    '╭● 🅤🅡🅛 ➤➤ http://circled.example:80',
                    '├● 🅤🅢🅔🅡 ➤➤ fixtureUserCircled',
                    '├● 🅟🅐🅢🅢 ➤➤ fixturePassCircled',
                    '╰● 🅜➌🅤 🅛🅘🅢🅣 ➤➤ http://circled.example:80/get.php?username=fixtureUserCircled&password=fixturePassCircled&type=m3u_plus',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://circled.example',
                username: 'fixtureUserCircled',
                password: 'fixturePassCircled',
            });
        });

        it('folds regional-indicator fancy text but leaves real flag emoji alone', () => {
            // 🇺🇸🇪🇷 / 🇵🇦🇸🇸 are runs of 3+ regional indicators — fancy text
            // for USER / PASS. 🇹🇷 is a run of exactly two — a real flag that
            // must not fold, or the glued "TR" would break the PORT label's
            // word boundary.
            const candidates = detectProviderImportCandidates(
                [
                    'Server: regional.example',
                    '🇹🇷PORT: 8080',
                    '🇺🇸🇪🇷 : carol',
                    '🇵🇦🇸🇸 : pa55',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://regional.example:8080',
                username: 'carol',
                password: 'pa55',
            });
        });

        it('does not read a hyphenated word as a labeled value', () => {
            expect(
                detectProviderImportCandidates(
                    'Our user-friendly setup takes a minute.'
                )
            ).toEqual([]);
        });

        it('reads an email-shaped username and ignores stats lines (synthetic fixture 1)', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://mail-login.example:80',
                    'User=viewer@example.com',
                    'Pass=fixturePassMail',
                    '30000 channels',
                    'Validity 31/12/2099',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://mail-login.example',
                username: 'viewer@example.com',
                password: 'fixturePassMail',
            });
        });

        it('reads the bare "URL, token, token" handout shape (synthetic fixture 2)', () => {
            const candidates = detectProviderImportCandidates(
                'http://bare-list.fixture.example\nfixtureAccount\nfixtureAccount'
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                confidence: 'low',
                serverUrl: 'http://bare-list.fixture.example',
                username: 'fixtureAccount',
                password: 'fixtureAccount',
            });
        });

        it('does not read prose around a lone URL as bare credentials', () => {
            expect(
                detectProviderImportCandidates(
                    'check out http://generic.fixture.example\nsee the attached guide\nthanks again'
                )
            ).toEqual([]);
        });

        it('handles indented labels and numeric credentials (synthetic fixture 4)', () => {
            const candidates = detectProviderImportCandidates(
                'http://numeric.example:8089\nUser: 111\n Pass: 111'
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://numeric.example:8089',
                username: '111',
                password: '111',
            });
        });

        it('prefers the get.php line of a full synthetic panel fixture', () => {
            const candidates = detectProviderImportCandidates(
                [
                    '𝙋𝙤𝙧𝙩𝙖𝙡 : http://198.51.100.25',
                    '• 𝘾𝙧𝙚𝙖𝙩𝙚𝙙 : 01/01/2030',
                    '• 𝙀𝙭𝙥 : 31/12/2099',
                    '• 𝙐𝙨𝙚𝙧 : fixtureUserPanel',
                    '• 𝙋𝙖𝙨𝙨 : fixturePassPanel',
                    '• 𝘾𝙤𝙣𝙣 : 1',
                    '• 𝙈𝙖𝙭𝘾𝙤𝙣𝙣 : 1',
                    '• 𝙋𝙤𝙧𝙩 : 8080',
                    '• 𝙎𝙩𝙖𝙩𝙪𝙨 : # OK ✅',
                    '• 𝐌𝟑𝐔 : http://198.51.100.25:8080/get.php?username=fixtureUserPanel&password=fixturePassPanel&type=m3u',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                confidence: 'high',
                serverUrl: 'http://198.51.100.25:8080',
                username: 'fixtureUserPanel',
                password: 'fixturePassPanel',
            });
        });

        it('completes a port-less labeled portal URL with the labeled port', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Portal : http://panel-port.example',
                    'Port : 8080',
                    'User : u1',
                    'Pass : p1',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream[0].serverUrl).toBe('http://panel-port.example:8080');
        });

        it('reads an inline one-line handout with pipe delimiters', () => {
            // No space after the pipe: the URL must not swallow the next
            // label, or the account silently produces no candidate at all.
            const candidates = detectProviderImportCandidates(
                'Server: http://inline-panel.fixture.example|User: alice|Pass: s3cret'
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0]).toMatchObject({
                serverUrl: 'http://inline-panel.fixture.example',
                username: 'alice',
                password: 's3cret',
            });
        });

        it('keeps an explicitly written default port over a labeled one', () => {
            // The WHATWG parser blanks `:80`, but the user wrote it.
            const candidates = detectProviderImportCandidates(
                [
                    'Server: http://primary.example:80/player_api.php',
                    'Port: 8080',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            // `:80` is http's default, so the shared normalizer collapses it
            // away — what matters is that the labeled 8080 never replaced it.
            expect(only(candidates, 'xtream')[0].serverUrl).toBe(
                'http://primary.example'
            );
        });

        it('keeps distinct accounts whose credentials contain the key separator', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel.example/get.php?username=a%7Cb&password=c',
                    'http://panel.example/get.php?username=a&password=b%7Cc',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(2);
            expect(
                xtream.map((candidate) => [
                    candidate.username,
                    candidate.password,
                ])
            ).toEqual([
                ['a|b', 'c'],
                ['a', 'b|c'],
            ]);
        });

        it('applies a labeled port to an IPv6 endpoint', () => {
            // The address is full of colons; none of them is a port.
            const candidates = detectProviderImportCandidates(
                [
                    'Server: http://[2001:db8:ffff::42]/player_api.php',
                    'Port: 8080',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].serverUrl).toBe(
                'http://[2001:db8:ffff::42]:8080'
            );
        });

        it('ignores host-shaped query keys inside unrelated links', () => {
            // `?url=guide` is a query key, not a label — the real "Server:"
            // line below it must still be the one the credentials attach to.
            const candidates = detectProviderImportCandidates(
                [
                    'Guide: https://reseller.example/setup?url=guide',
                    'Server: http://panel.example',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].serverUrl).toBe('http://panel.example');
        });

        it('strips sentence punctuation from a labeled server URL', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Server: http://punctuation-panel.fixture.example!',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].serverUrl).toBe(
                'http://punctuation-panel.fixture.example'
            );
        });

        it('completes a port-less API URL with the separately labeled port', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Server: http://panel.example/player_api.php',
                    'Port: 8080',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].serverUrl).toBe('http://panel.example:8080');
        });

        it('does not let a labeled port override an explicit one', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Server: http://panel.example:2500/player_api.php',
                    'Port: 8080',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            expect(only(candidates, 'xtream')[0].serverUrl).toBe(
                'http://panel.example:2500'
            );
        });

        it('strips panel_api.php from the derived server URL', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel.example/panel_api.php',
                    'User: alice',
                    'Pass: s3cret',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].serverUrl).toBe('http://panel.example');
        });

        it('treats credentials in the query of a generic URL as xtream', () => {
            const candidates = detectProviderImportCandidates(
                'http://query-credentials.example/api?username=fixtureUserQuery&password=fixturePassQuery&foo=bar'
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].username).toBe('fixtureUserQuery');
            expect(xtream[0].password).toBe('fixturePassQuery');
        });
    });

    describe('stalker detection', () => {
        it('pairs a MAC with a portal-shaped URL at high confidence', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Portal: http://stb.example/stalker_portal/c/',
                    'MAC: 00:1A:79:12:34:56',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                confidence: 'high',
                portalUrl: 'http://stb.example/stalker_portal/c/',
                macAddress: '00:1A:79:12:34:56',
                suggestedTitle: 'stb.example',
            });
        });

        it('accepts /c/ and portal.php shaped URLs as portals', () => {
            for (const url of [
                'http://p.example/c/',
                'http://p.example/portal.php',
                'http://p.example/server/load.php',
            ]) {
                const candidates = detectProviderImportCandidates(
                    `${url}\n00-1A-79-AB-CD-EF`
                );
                const stalker = only(candidates, 'stalker');
                expect(stalker[0]?.portalUrl).toBe(url);
                expect(stalker[0]?.confidence).toBe('high');
            }
        });

        it('falls back to a generic URL at medium confidence', () => {
            const candidates = detectProviderImportCandidates(
                'http://somehost.example/tv\nmac: 00:1a:79:aa:bb:cc'
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0].confidence).toBe('medium');
            expect(stalker[0].portalUrl).toBe('http://somehost.example/tv');
            expect(stalker[0].macAddress).toBe('00:1A:79:AA:BB:CC');
        });

        it('keeps the closing bracket of a root IPv6 portal URL', () => {
            // `]` closes the authority here; stripping it as prose would
            // leave an address that cannot be parsed or imported.
            const candidates = detectProviderImportCandidates(
                [
                    'Portal: http://[2001:db8:ffff::99]',
                    'MAC: 00:1A:79:00:60:01',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0].portalUrl).toBe(
                'http://[2001:db8:ffff::99]'
            );
        });

        it('proposes a low-confidence stalker candidate for a lone MAC', () => {
            const candidates = detectProviderImportCandidates(
                'Ваш MAC 00:1A:79:00:11:22 активирован'
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0].confidence).toBe('low');
            expect(stalker[0].portalUrl).toBeUndefined();
        });

        it('recognizes a bare Infomir MAC but not a bare foreign 12-hex run', () => {
            const infomir = detectProviderImportCandidates('mac 001a79deadbe');
            expect(only(infomir, 'stalker')).toHaveLength(1);
            expect(only(infomir, 'stalker')[0].macAddress).toBe(
                '00:1A:79:DE:AD:BE'
            );

            const foreign = detectProviderImportCandidates(
                'token aabbccddeeff issued'
            );
            expect(only(foreign, 'stalker')).toHaveLength(0);
        });

        it('accepts a labeled non-Infomir MAC', () => {
            const candidates = detectProviderImportCandidates(
                'MAC: A0:B1:C2:D3:E4:F5\nhttp://p.example/c/'
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0].macAddress).toBe('A0:B1:C2:D3:E4:F5');
        });

        it('captures serial, device IDs and signatures', () => {
            const deviceId1 = 'a'.repeat(64);
            const deviceId2 = 'b'.repeat(64);
            const signature1 = 'c'.repeat(64);
            const signature2 = 'd'.repeat(64);
            const candidates = detectProviderImportCandidates(
                [
                    'Portal: http://stb.example/c/',
                    'MAC: 00:1A:79:12:34:56',
                    'Serial Number: 0123456789AB',
                    `Device ID: ${deviceId1}`,
                    `Device ID 2: ${deviceId2}`,
                    `Signature: ${signature1}`,
                    `Signature 2: ${signature2}`,
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker[0]).toMatchObject({
                serialNumber: '0123456789AB',
                deviceId1,
                deviceId2,
                signature1,
                signature2,
            });
        });

        it('rejects non-hex device IDs and signatures instead of guessing', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'MAC: 00:1A:79:12:34:56',
                    'Device ID: see-attachment',
                    'Signature: n/a',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker[0].deviceId1).toBeUndefined();
            expect(stalker[0].signature1).toBeUndefined();
        });

        it('does not read a MAC out of a 64-hex device ID blob', () => {
            const candidates = detectProviderImportCandidates(
                `device id: ${'001a79'.repeat(10)}aabb`
            );

            expect(only(candidates, 'stalker')).toHaveLength(0);
        });

        it('produces one candidate per MAC when several are handed out', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://multi.example/c/',
                    '00:1A:79:11:11:11',
                    '00:1A:79:22:22:22',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            expect(stalker.map((candidate) => candidate.macAddress)).toEqual([
                '00:1A:79:11:11:11',
                '00:1A:79:22:22:22',
            ]);
        });

        it('reads a dual "DEVICE ID=> 1&2 <hex>" line into both device slots and "S N" as serial', () => {
            const deviceHex =
                '1111111111111111111111111111111111111111111111111111111111111111';
            const candidates = detectProviderImportCandidates(
                [
                    'http://device-a.example/stalker_portal/c',
                    'MAC=> 00:1A:79:00:10:01',
                    'EXP=> 2099-01-13',
                    'MAX => 10000',
                    'ADULT PASS=> 0000',
                    'S N=> 1111111111111',
                    `DEVICE ID=> 1&2 ${deviceHex}`,
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                portalUrl: 'http://device-a.example/stalker_portal/c',
                macAddress: '00:1A:79:00:10:01',
                serialNumber: '1111111111111',
                deviceId1: deviceHex,
                deviceId2: deviceHex,
            });
            // The parental-control PIN is not the account password.
            expect(stalker[0].password).toBeUndefined();
        });

        it('reads a synthetic Turkish-labeled decorated portal message', () => {
            const candidates = detectProviderImportCandidates(
                [
                    '⚙️➤System : Synthetic Fixture Tool v1.0 (MAC)',
                    '🔌➤Portal Type : Stalker / XUI (/c/)',
                    '✅➤Tarama Zamanı: 2099-03-05 13:28:23',
                    '🌍➤Portal : http://turkish.example:80/c/',
                    '🆔➤MAC ADRESİ: 00:1A:79:00:10:02',
                    '📆➤Son Tarih : Süresiz',
                    '🖥➤Plan : MAG/MAC',
                    '🔊➤ɢᴏʀᴜɴᴛᴜ: Var 👍',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                portalUrl: 'http://turkish.example:80/c/',
                macAddress: '00:1A:79:00:10:02',
            });
        });

        it('reads a synthetic decorated fixture with Real/Panel labels', () => {
            const candidates = detectProviderImportCandidates(
                [
                    '├○ 𝑹𝒆𝒂𝒍 ➤ http://decorated-stalker.example:80/c/',
                    '├○ 𝑷𝒂𝒏𝒆𝒍 ➤ http://decorated-stalker.example/c/',
                    '├○ 𝑴𝒂𝒄 ➤ 00:1A:79:00:10:03',
                    '├○ 𝑷𝒂𝒏𝒆𝒍 𝑻𝒚𝒑𝒆 ➤ portal.php',
                    '├○ 𝑬𝒙𝒑 ➤ July 26, 2099, 12:41 pm',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                confidence: 'high',
                portalUrl: 'http://decorated-stalker.example:80/c/',
                macAddress: '00:1A:79:00:10:03',
            });
        });

        it('produces one candidate per MAC of a synthetic multi-account list', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://multi-account.example/c/',
                    '00:1A:79:00:20:01  13/01/2099',
                    '00:1A:79:00:20:02  31/12/2099 (513 Days)',
                    '00:1A:79:00:20:03  18/08/2099 (378 Days)',
                    '00:1A:79:00:20:04  16/08/2099 (377 Days)',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(4);
            expect(
                stalker.every(
                    (candidate) =>
                        candidate.portalUrl === 'http://multi-account.example/c/'
                )
            ).toBe(true);
            expect(stalker.map((candidate) => candidate.macAddress)).toEqual([
                '00:1A:79:00:20:01',
                '00:1A:79:00:20:02',
                '00:1A:79:00:20:03',
                '00:1A:79:00:20:04',
            ]);
        });

        it('reads separator-less SN and a decorated synthetic dual device ID', () => {
            const deviceHex =
                '2222222222222222222222222222222222222222222222222222222222222222';
            const candidates = detectProviderImportCandidates(
                [
                    'http://device-b.example/stalker_portal/c/',
                    'Mac 00:1a:79:00:30:01',
                    '𝐄𝐗𝐏 𝐃𝐚𝐭𝐞 2099-08-07',
                    '🔥 🆅🅿️🅽 Toronto',
                    '𝐒𝐍 2222222222222',
                    `𝐃𝐞𝐯𝐢𝐜𝐞𝐈𝐃 ¹💥² ${deviceHex}`,
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                portalUrl: 'http://device-b.example/stalker_portal/c/',
                macAddress: '00:1A:79:00:30:01',
                serialNumber: '2222222222222',
                deviceId1: deviceHex,
                deviceId2: deviceHex,
            });
        });

        it('ignores synthetic decorative footers and status prose around a portal', () => {
            const candidates = detectProviderImportCandidates(
                [
                    '├○ 𝑺𝒄𝒂𝒏𝒏𝒆𝒅 𝑩𝒚 ➤ ★☆★ Synthetic Fixture Generator ★☆★',
                    '├○ 𝑺𝒄𝒂𝒏 𝑫𝒂𝒕𝒆 / 𝑻𝒊𝒎𝒆 ➤ 11.08.2099. • 11:38:54',
                    '├○ 𝑹𝒆𝒂𝒍 ➤ http://decorative-footer.example:80',
                    '├○ 𝑷𝒂𝒏𝒆𝒍 ➤ http://decorative-footer.example:80/c/',
                    '├○ 𝑴𝒂𝒄 ➤ 00:1A:79:00:40:01',
                    '├○ 𝑷𝒂𝒏𝒆𝒍 𝑻𝒚𝒑𝒆 ➤ portal.php',
                    '├○ 𝑬𝒙𝒑 ➤ July 12, 2099, 12:00 am -30 Days',
                    '├○ 𝑽𝒑𝒏 ➤  𝑁𝑜 𝐶𝑙𝑖𝑒𝑛𝑡 𝐼𝑃 𝐴𝑑𝑑𝑟𝑒𝑠𝑠',
                    '├○ 𝑰𝒎𝒂𝒈𝒆 ➤  𝐼𝑛𝑣𝑎𝑙𝑖𝑑 𝑂𝑝𝑝𝑠',
                    '└──➢ 𝑴𝑨𝑪 𝑷𝑹𝑶 𝑨𝑻𝑳𝑨𝑺',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                portalUrl: 'http://decorative-footer.example:80/c/',
                macAddress: '00:1A:79:00:40:01',
            });
            expect(only(candidates, 'xtream')).toHaveLength(0);
        });

        it('reads a synthetic [+]-prefixed fixture with device identity fields', () => {
            const deviceId =
                '3333333333333333333333333333333333333333333333333333333333333333';
            const signature =
                '4444444444444444444444444444444444444444444444444444444444444444';
            const candidates = detectProviderImportCandidates(
                [
                    '[+] Panel: http://identity.example:80/c',
                    '[+] Real: identity.example',
                    '[+] Mac: 02:00:00:00:50:01',
                    '[+] Exp.: February 27, 2099, 7:33 pm',
                    '[+] ᴍᴀᴄ ꜱᴛᴀᴛᴜꜱ: ᴍᴀᴄ ᴏꜰꜰ🥺',
                    '[+] ᴍ3ᴜ ꜱᴛᴀᴛᴜꜱ: ᴏꜰꜰʟɪɴᴇ😔',
                    '[+] ᴄʜᴀɴɴᴇʟCategories: 684',
                    '[+] m3u_Url: ',
                    '',
                    '[+] Serial: 3333333333333',
                    '[+] Device ID: ' + deviceId,
                    '[+] Signature: ' + signature,
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0]).toMatchObject({
                portalUrl: 'http://identity.example:80/c',
                macAddress: '02:00:00:00:50:01',
                serialNumber: '3333333333333',
                deviceId1: deviceId,
                signature1: signature,
            });
            expect(stalker[0].deviceId2).toBeUndefined();
        });

        it('does not cross-pair global identity labels onto multiple MACs', () => {
            // First-match-wins labels cannot say WHOSE serial/device ID they
            // are once a second MAC appears — and a device ID submitted with
            // the wrong MAC gets pinned by the portal permanently. Multi-MAC
            // candidates must therefore carry portal + MAC only.
            const candidates = detectProviderImportCandidates(
                [
                    'Portal: http://multi.example/c/',
                    'MAC: 00:1A:79:11:11:11',
                    `Device ID: ${'a'.repeat(64)}`,
                    'SN: AAAA1111BBBB2',
                    'MAC: 00:1A:79:22:22:22',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBe(
                    'http://multi.example/c/'
                );
                expect(candidate.deviceId1).toBeUndefined();
                expect(candidate.serialNumber).toBeUndefined();
            }
        });

        it('omits the portal when several MACs meet portals on different hosts', () => {
            // Two panels + two MACs in one paste: no deterministic owner for
            // either portal, so the candidates carry the MAC alone instead of
            // prefilling half of them with the wrong panel.
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel-a.example/c/',
                    'MAC: 00:1A:79:AA:AA:AA',
                    'http://panel-b.example/c/',
                    'MAC: 00:1A:79:BB:BB:BB',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBeUndefined();
                expect(candidate.confidence).toBe('low');
            }
        });

        it('completes a port-less shaped portal with the separately labeled port', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Portal: http://stb.example/c/',
                    'Port: 8080',
                    'MAC: 00:1A:79:12:34:56',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(1);
            expect(stalker[0].portalUrl).toBe('http://stb.example:8080/c/');
        });

        it('treats tenant installs under different base paths as different panels', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel.example/a/stalker_portal/c/',
                    'MAC: 00:1A:79:AA:AA:AA',
                    'http://panel.example/b/stalker_portal/c/',
                    'MAC: 00:1A:79:BB:BB:BB',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBeUndefined();
            }
        });

        it('applies the labeled port before judging portal ambiguity', () => {
            // Both URLs are the same panel once "Port: 8080" completes the
            // port-less one — the MAC list must keep the shared portal.
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel.example:8080/c/',
                    'http://panel.example/c/',
                    'Port: 8080',
                    'MAC: 00:1A:79:AA:AA:AA',
                    'MAC: 00:1A:79:BB:BB:BB',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBe(
                    'http://panel.example:8080/c/'
                );
            }
        });

        it('keeps alternate endpoints of one install unambiguous for a MAC list', () => {
            // /c/ and portal.php are two doors into the same installation —
            // a MAC list next to both must still get the shared portal.
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel.example/c/',
                    'http://panel.example/portal.php',
                    'MAC: 00:1A:79:AA:AA:AA',
                    'MAC: 00:1A:79:BB:BB:BB',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBe('http://panel.example/c/');
            }
        });

        it('treats same-host portals on different ports as different panels', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel.example:8080/c/',
                    'MAC: 00:1A:79:AA:AA:AA',
                    'http://panel.example:9090/c/',
                    'MAC: 00:1A:79:BB:BB:BB',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBeUndefined();
            }
        });

        it('treats several MACs with generic URLs on different hosts as ambiguous too', () => {
            // Without portal-shaped URLs the picker falls back to a generic
            // URL — the ambiguity guard must cover that pool as well, or two
            // root-URL panels would still cross-pair through the fallback.
            const candidates = detectProviderImportCandidates(
                [
                    'http://panel-a.example',
                    'MAC: 00:1A:79:AA:AA:AA',
                    'http://panel-b.example',
                    'MAC: 00:1A:79:BB:BB:BB',
                ].join('\n')
            );

            const stalker = only(candidates, 'stalker');
            expect(stalker).toHaveLength(2);
            for (const candidate of stalker) {
                expect(candidate.portalUrl).toBeUndefined();
            }
        });

        it('surfaces every MAC of a long multi-account list', () => {
            const macs = Array.from(
                { length: 20 },
                (_, index) =>
                    `00:1A:79:${String(index).padStart(2, '0')}:11:22`
            );
            const candidates = detectProviderImportCandidates(
                ['http://long.example/c/', ...macs].join('\n')
            );

            expect(only(candidates, 'stalker')).toHaveLength(20);
        });

        it('gives labeled credentials to the stalker candidate, not a competing xtream guess', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Portal: http://stb.example/c/',
                    'MAC: 00:1A:79:12:34:56',
                    'Login: stbuser',
                    'Password: stbpass',
                ].join('\n')
            );

            expect(only(candidates, 'xtream')).toHaveLength(0);
            const stalker = only(candidates, 'stalker');
            expect(stalker[0].username).toBe('stbuser');
            expect(stalker[0].password).toBe('stbpass');
        });
    });

    describe('m3u detection', () => {
        it('detects .m3u and .m3u8 links at high confidence', () => {
            const candidates = detectProviderImportCandidates(
                'List 1: https://lists.example/main.m3u\nList 2: https://lists.example/backup.m3u8'
            );

            const m3u = only(candidates, 'm3u-url');
            expect(m3u).toHaveLength(2);
            expect(m3u.every((c) => c.confidence === 'high')).toBe(true);
            expect(m3u[0].url).toBe('https://lists.example/main.m3u');
            expect(m3u[0].suggestedTitle).toBe('lists.example');
        });

        it('strips trailing punctuation from a link found in prose', () => {
            const candidates = detectProviderImportCandidates(
                'Your playlist (https://lists.example/main.m3u).'
            );

            expect(only(candidates, 'm3u-url')[0].url).toBe(
                'https://lists.example/main.m3u'
            );
        });

        it('does not turn an .m3u link with query credentials into an xtream server', () => {
            const candidates = detectProviderImportCandidates(
                'https://lists.example/files/list.m3u8?username=u&password=p'
            );

            expect(only(candidates, 'xtream')).toHaveLength(0);
            expect(only(candidates, 'm3u-url')).toHaveLength(1);
        });

        it('routes a pasted playlist body to the raw-text import', () => {
            const body =
                '#EXTM3U\n#EXTINF:-1 tvg-id="one",Channel One\nhttp://streams.example/1.ts';
            const candidates = detectProviderImportCandidates(body);

            expect(candidates).toEqual([
                { kind: 'm3u-text', confidence: 'high', text: body },
            ]);
        });
    });

    describe('mixed messages and ranking', () => {
        it('surfaces every source found in a combined provider message', () => {
            const candidates = detectProviderImportCandidates(
                [
                    'Xtream: http://x.example:8080/get.php?username=u1&password=p1',
                    'Backup M3U: http://x.example:8080/files/backup.m3u',
                    'Stalker portal: http://s.example/c/',
                    'MAC: 00:1A:79:99:88:77',
                ].join('\n')
            );

            expect(only(candidates, 'stalker')).toHaveLength(1);
            expect(only(candidates, 'xtream')).toHaveLength(1);
            expect(only(candidates, 'm3u-url').length).toBeGreaterThanOrEqual(1);
            // High-confidence candidates sort ahead of low-confidence ones.
            const ranks = candidates.map((candidate) => candidate.confidence);
            const firstLow = ranks.indexOf('low');
            const lastHigh = ranks.lastIndexOf('high');
            expect(firstLow === -1 || lastHigh < firstLow).toBe(true);
        });

        it('dedupes an URL pasted twice', () => {
            const candidates = detectProviderImportCandidates(
                'https://lists.example/main.m3u\nhttps://lists.example/main.m3u'
            );

            expect(only(candidates, 'm3u-url')).toHaveLength(1);
        });

        it('does not read credentials out of URLs beyond the extraction cap', () => {
            // URL #17 is past the 16-URL cap and never becomes a candidate;
            // its query credentials must not leak into the label matchers and
            // attach to the early credential-less panel.
            const filler = Array.from(
                { length: 15 },
                (_, index) => `https://lists.example/list-${index}.m3u`
            );
            const candidates = detectProviderImportCandidates(
                [
                    'http://early.example/player_api.php',
                    ...filler,
                    'http://late.example/x?username=wrong&password=wrongpass',
                ].join('\n')
            );

            const xtream = only(candidates, 'xtream');
            expect(xtream).toHaveLength(1);
            expect(xtream[0].serverUrl).toBe('http://early.example');
            expect(xtream[0].username).toBeUndefined();
            expect(xtream[0].password).toBeUndefined();
        });

        it('surfaces every link of a long list and caps only pathological pastes', () => {
            const twelve = Array.from(
                { length: 12 },
                (_, index) => `https://lists.example/list-${index}.m3u`
            ).join('\n');
            expect(detectProviderImportCandidates(twelve)).toHaveLength(12);

            const twenty = Array.from(
                { length: 20 },
                (_, index) => `https://lists.example/list-${index}.m3u`
            ).join('\n');
            expect(detectProviderImportCandidates(twenty)).toHaveLength(16);
        });
    });
});
