/** @type {AppTypes.Config} */

/**
 * CBCT Viewer — packaged app configuration.
 *
 * This config is used by the Android (.apk), iOS (.ipa) and Windows (.exe)
 * builds. It differs from the stock OHIF configs in three ways:
 *
 *   1. It is OFFLINE-FIRST. The only data source is `dicomlocal`, which reads
 *      DICOM files the user picks from the device. There is no PACS/DICOMweb
 *      server involved, so the app works with no network at all.
 *
 *   2. It exposes a USER-FACING RENDERING QUALITY setting. CBCT volumes are
 *      large (a few hundred slices is normal) and a phone GPU cannot always
 *      hold one at full precision. The user picks a preset; the preset maps to
 *      concrete cornerstone settings that are applied at boot.
 *
 *   3. It injects a small settings panel (the gear button, bottom-right) so the
 *      quality preset can be changed from inside the packaged app, where there
 *      is no address bar to pass URL parameters through.
 *
 * -----------------------------------------------------------------------------
 * IMPORTANT — NOT A CERTIFIED MEDICAL DEVICE
 * This build has not been cleared or certified by any regulatory body (FDA, CE/
 * MDR, or otherwise). The quality presets below intentionally *reduce* image
 * fidelity to fit constrained hardware. Do not rely on this viewer as the
 * primary basis for diagnosis or treatment planning.
 * -----------------------------------------------------------------------------
 */

(function () {
  // --- error capture ---------------------------------------------------------
  // A packaged webview has no devtools, so anything that fails during decoding
  // would otherwise be invisible. Keep the last handful of errors so the
  // diagnostics panel can show them on the device.
  const capturedErrors = [];
  function captureError(source, args) {
    try {
      const text = Array.prototype.map
        .call(args, function (a) {
          if (a instanceof Error) return a.message;
          if (typeof a === 'object') {
            try {
              return JSON.stringify(a).slice(0, 200);
            } catch (e) {
              return String(a);
            }
          }
          return String(a);
        })
        .join(' ')
        .slice(0, 300);
      if (text && capturedErrors.indexOf(text) === -1) {
        capturedErrors.push(source + ': ' + text);
        if (capturedErrors.length > 8) capturedErrors.shift();
      }
    } catch (e) {
      // never let the logger break the app
    }
  }

  const originalConsoleError = console.error.bind(console);
  console.error = function () {
    captureError('console', arguments);
    originalConsoleError.apply(null, arguments);
  };
  window.addEventListener('error', function (e) {
    captureError('error', [e.message]);
  });
  window.addEventListener('unhandledrejection', function (e) {
    captureError('promise', [(e.reason && e.reason.message) || e.reason]);
  });

  // --- landing route ---------------------------------------------------------
  // With `showStudyList: false` OHIF registers no route for `/`, so the app
  // would boot straight into its 404 page. The local file loader lives at
  // `/localbasic`, which drops the user into the viewer once files are picked
  // (`/local` instead returns to the study list, which does not exist here).
  // This runs before the app bundle, so the router sees the corrected path on
  // its first read.
  const path = window.location.pathname;
  if (path === '/' || path === '' || path === '/index.html') {
    window.history.replaceState(null, '', '/localbasic' + window.location.search);
  }

  const STORAGE_KEY = 'cbct-viewer:quality';
  const PRECISION_KEY = 'cbct-viewer:force16bit';
  const MB = 1024 * 1024;

  /**
   * Quality presets.
   *
   * maxCacheSize             bytes cornerstone may hold in its image cache
   * maxNumberOfWebWorkers    decode parallelism (more = faster, more RAM)
   * preferSizeOverAccuracy   8-bit volume textures instead of 16-bit. Halves
   *                          GPU memory. Slightly coarser intensity steps.
   * sampleDistanceMultiplier 3D raycast step size. 1 = sample every voxel
   *                          (sharpest, slowest). Higher = faster, grainier.
   * webGlContextCount        simultaneous WebGL contexts; fewer is safer on
   *                          mobile GPUs that drop contexts under pressure.
   */
  const PRESETS = {
    low: {
      label: 'Low — maximum compatibility',
      hint: 'Older or low-RAM phones. Coarse 3D, but least likely to crash.',
      maxCacheSize: 256 * MB,
      maxNumberOfWebWorkers: 2,
      preferSizeOverAccuracy: true,
      sampleDistanceMultiplier: 4,
      webGlContextCount: 1,
      prefetch: 10,
    },
    medium: {
      label: 'Medium — balanced',
      hint: 'Good default for most phones and tablets.',
      maxCacheSize: 768 * MB,
      maxNumberOfWebWorkers: 3,
      preferSizeOverAccuracy: true,
      sampleDistanceMultiplier: 2,
      webGlContextCount: 2,
      prefetch: 20,
    },
    high: {
      label: 'High — full precision',
      hint: 'Recent flagship phones, tablets and most PCs. 16-bit volumes.',
      maxCacheSize: 1536 * MB,
      maxNumberOfWebWorkers: 4,
      preferSizeOverAccuracy: false,
      sampleDistanceMultiplier: 1.5,
      webGlContextCount: 3,
      prefetch: 25,
    },
    ultra: {
      label: 'Ultra — desktop',
      hint: 'Windows/desktop with a dedicated GPU. Sharpest 3D, most memory.',
      maxCacheSize: 3072 * MB,
      maxNumberOfWebWorkers: 6,
      preferSizeOverAccuracy: false,
      sampleDistanceMultiplier: 1,
      webGlContextCount: 4,
      prefetch: 40,
    },
  };

  const PRESET_ORDER = ['low', 'medium', 'high', 'ultra'];

  /**
   * Window/level presets for dental CBCT.
   *
   * These are also registered with OHIF's own preset menu (see
   * `cornerstone.windowLevelPresets` below), but that menu sits behind a
   * toolbar button that is easy to miss on a narrow phone toolbar, so the same
   * values are offered here as one-tap buttons.
   */
  const WL_PRESETS = [
    { name: 'Bone', window: 2500, level: 500 },
    { name: 'Teeth', window: 3500, level: 1400 },
    { name: 'Soft tissue', window: 500, level: 60 },
    { name: 'Airway', window: 1400, level: -400 },
    { name: 'Full range', window: 4000, level: 900 },
  ];

  /**
   * Apply a window/level to whichever viewport is active.
   *
   * `window.commandsManager` and `window.services` are set by the cornerstone
   * extension during init, so they exist by the time the user can press a
   * button. Failures are reported in the panel rather than thrown, because a
   * missing viewport simply means nothing is loaded yet.
   */
  function applyWindowLevel(windowWidth, windowCenter) {
    const commandsManager = window.commandsManager;
    const services = window.services;
    if (!commandsManager || !services || !services.viewportGridService) {
      return 'Viewer not ready yet.';
    }
    const viewportId = services.viewportGridService.getState().activeViewportId;
    if (!viewportId) {
      return 'No active viewport.';
    }
    try {
      commandsManager.runCommand('setViewportWindowLevel', {
        viewportId: viewportId,
        windowWidth: windowWidth,
        windowCenter: windowCenter,
      });
      return null;
    } catch (e) {
      console.warn('[CBCT] window/level failed', e);
      return 'Could not apply — is a study loaded?';
    }
  }

  // --- platform detection ----------------------------------------------------
  // Capacitor exposes window.Capacitor; Tauri exposes __TAURI__ / __TAURI_INTERNALS__.
  const isCapacitor = typeof window.Capacitor !== 'undefined';
  const isTauri =
    typeof window.__TAURI__ !== 'undefined' ||
    typeof window.__TAURI_INTERNALS__ !== 'undefined';
  const isPackaged = isCapacitor || isTauri;

  const isMobileDevice =
    isCapacitor ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
    // iPadOS 13+ reports as desktop Safari but has a touch screen.
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  /**
   * Pick a preset when the user has chosen "auto".
   *
   * navigator.deviceMemory is Chromium-only (so: Android yes, iOS Safari no)
   * and is deliberately coarse — it reports 0.25/0.5/1/2/4/8 GB and caps at 8.
   * hardwareConcurrency is available almost everywhere and is used as the
   * fallback signal. When we know nothing, we bias LOW on mobile: a viewer that
   * renders coarsely is far more useful than one that runs out of memory and
   * shows a blank viewport.
   */
  function autoDetectPreset() {
    const memory = navigator.deviceMemory; // GB, may be undefined
    const cores = navigator.hardwareConcurrency || 0;

    if (!isMobileDevice) {
      // Desktop: Tauri/Windows and browsers on a PC.
      if (memory && memory <= 4) return 'high';
      return 'ultra';
    }

    if (memory) {
      if (memory <= 2) return 'low';
      if (memory <= 4) return 'medium';
      return 'high';
    }

    // No deviceMemory signal (typical on iOS). Fall back to core count.
    if (cores >= 6) return 'medium';
    return 'low';
  }

  function readStoredChoice() {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'auto' || PRESETS[stored]) return stored;
    } catch (e) {
      // localStorage can throw in private mode / restricted webviews.
    }
    return 'auto';
  }

  const choice = readStoredChoice();
  const resolvedKey = choice === 'auto' ? autoDetectPreset() : choice;
  const preset = PRESETS[resolvedKey];

  // Texture precision is kept as its own switch, separate from the memory
  // preset. CBCT data spans a wide value range, and squeezing it into an 8-bit
  // texture can flatten the contrast between bone, enamel and soft tissue to
  // the point where the image looks like uniform grey. Being able to force
  // 16-bit without also raising the cache size makes that testable on a device
  // that cannot afford the High preset.
  function readForce16Bit() {
    try {
      const stored = window.localStorage.getItem(PRECISION_KEY);
      if (stored === 'true') return true;
      if (stored === 'false') return false;
    } catch (e) {
      // localStorage may be unavailable in a restricted webview.
    }
    return null; // follow the preset
  }

  const force16Bit = readForce16Bit();
  const preferSizeOverAccuracy =
    force16Bit === null ? preset.preferSizeOverAccuracy : !force16Bit;

  // Expose for the settings UI and for troubleshooting from a console.
  window.cbctQuality = {
    storageKey: STORAGE_KEY,
    presets: PRESETS,
    presetOrder: PRESET_ORDER,
    choice: choice,
    resolved: resolvedKey,
    force16Bit: force16Bit,
    preferSizeOverAccuracy: preferSizeOverAccuracy,
    isMobileDevice: isMobileDevice,
    isPackaged: isPackaged,
    platform: isCapacitor ? 'capacitor' : isTauri ? 'tauri' : 'browser',
    detected: {
      deviceMemoryGB: navigator.deviceMemory ?? null,
      cores: navigator.hardwareConcurrency ?? null,
    },
    set: function (value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, value);
      } catch (e) {
        console.warn('Could not persist quality choice', e);
      }
      window.location.reload();
    },
    setForce16Bit: function (value) {
      try {
        if (value === null) {
          window.localStorage.removeItem(PRECISION_KEY);
        } else {
          window.localStorage.setItem(PRECISION_KEY, value ? 'true' : 'false');
        }
      } catch (e) {
        console.warn('Could not persist precision choice', e);
      }
      window.location.reload();
    },
  };

  console.log(
    `[CBCT] quality "${choice}" -> "${resolvedKey}"`,
    window.cbctQuality.detected
  );

  // --- OHIF configuration ----------------------------------------------------
  window.config = {
    name: 'config/cbct.js',
    // null keeps every asset path relative to wherever index.html is served
    // from. Required for the Capacitor webview and the Tauri asset protocol.
    routerBasename: null,
    extensions: [],
    modes: [],
    customizationService: [
      '@ohif/extension-default.customizationModule.theme',
      {
        // Dental CBCT is reported under the CT modality but is not calibrated
        // the way a medical CT is, so OHIF's stock CT presets (soft tissue at
        // level 40, lung at -600) land nowhere near the data. Left alone, the
        // viewer auto-windows to the full value range — on a typical scan that
        // is a window several thousand wide, which compresses every tissue into
        // near-identical grey. These presets sit where dental CBCT data
        // actually lives; the stock CT ones are kept underneath.
        'cornerstone.windowLevelPresets': {
          CT: [
            { id: 'cbct-bone', description: 'CBCT bone', window: '2500', level: '500' },
            { id: 'cbct-teeth', description: 'CBCT teeth / enamel', window: '3500', level: '1400' },
            { id: 'cbct-soft', description: 'CBCT soft tissue', window: '500', level: '60' },
            { id: 'cbct-airway', description: 'CBCT airway / sinus', window: '1400', level: '-400' },
            { id: 'cbct-wide', description: 'CBCT full range', window: '4000', level: '900' },
            { id: 'ct-soft-tissue', description: 'CT soft tissue', window: '400', level: '40' },
            { id: 'ct-bone', description: 'CT bone', window: '2500', level: '480' },
            { id: 'ct-lung', description: 'CT lung', window: '1500', level: '-600' },
          ],
        },
      },
    ],

    // No remote study list — this build opens local files only.
    showStudyList: false,

    // Applied by extensions/cornerstone/src/init.tsx.
    renderingQuality: {
      preferSizeOverAccuracy: preferSizeOverAccuracy,
      sampleDistanceMultiplier: preset.sampleDistanceMultiplier,
      webGlContextCount: preset.webGlContextCount,
    },
    isMobile: isMobileDevice,
    maxCacheSize: preset.maxCacheSize,
    maxNumberOfWebWorkers: preset.maxNumberOfWebWorkers,
    maxNumRequests: {
      interaction: 100,
      thumbnail: 5,
      prefetch: preset.prefetch,
    },

    showWarningMessageForCrossOrigin: false,
    showCPUFallbackMessage: true,
    showLoadingIndicator: true,
    strictZSpacingForVolumeViewport: true,
    groupEnabledModesFirst: true,
    allowMultiSelectExport: false,
    showErrorDetails: 'always',
    useSharedArrayBuffer: 'AUTO',

    defaultDataSourceName: 'dicomlocal',
    dataSources: [
      {
        namespace: '@ohif/extension-default.dataSourcesModule.dicomlocal',
        sourceName: 'dicomlocal',
        configuration: {
          friendlyName: 'Local files',
        },
      },
    ],
  };

  /**
   * Collect what is actually in the loaded data.
   *
   * The point of this is to separate "the pixels are uniform" from "windowing
   * is wrong". If the scalar range comes back as a single value, no window
   * setting will ever produce an image and the problem is upstream in
   * decoding. The DICOM tags then say why — transfer syntax in particular,
   * since a compressed syntax needs a WASM codec that may not be reachable
   * inside a packaged webview.
   */
  function collectDiagnostics() {
    const lines = [];
    const services = window.services;

    function add(label, value) {
      if (value === undefined || value === null || value === '') return;
      lines.push(label + ': ' + value);
    }

    if (!services) {
      return ['Viewer not ready yet.'];
    }

    // --- DICOM tags from the loaded display set ---
    try {
      const displaySets = services.displaySetService.getActiveDisplaySets();
      const ds = displaySets && displaySets[0];
      const inst = ds && ds.instances && ds.instances[0];
      if (inst) {
        add('Modality', inst.Modality);
        add('Transfer syntax', inst.TransferSyntaxUID || inst.AvailableTransferSyntaxUID);
        add('SOP class', inst.SOPClassUID);
        add('Size', (inst.Rows || '?') + ' x ' + (inst.Columns || '?'));
        add('Bits alloc/stored', inst.BitsAllocated + '/' + inst.BitsStored);
        add('Pixel repr', inst.PixelRepresentation);
        add('Photometric', inst.PhotometricInterpretation);
        add('Rescale slope/int', inst.RescaleSlope + ' / ' + inst.RescaleIntercept);
        add('Frames', inst.NumberOfFrames);
        add('Samples/px', inst.SamplesPerPixel);
        add('Instances', ds.instances.length);
        add('Window in file', inst.WindowWidth + ' / ' + inst.WindowCenter);
      } else {
        lines.push('No display set loaded.');
      }
    } catch (e) {
      lines.push('Tag read failed: ' + e.message);
    }

    // --- actual voxel values in the rendered viewport ---
    try {
      const viewportId = services.viewportGridService.getState().activeViewportId;
      const engine = services.cornerstoneViewportService.getRenderingEngine();
      const viewport = engine && engine.getViewport(viewportId);
      const imageData = viewport && viewport.getImageData && viewport.getImageData();

      if (imageData) {
        add('Dimensions', (imageData.dimensions || []).join(' x '));
        add('Spacing', (imageData.spacing || []).map(function (n) {
          return Number(n).toFixed(3);
        }).join(', '));

        let range = null;
        if (imageData.imageData && imageData.imageData.getPointData) {
          const scalars = imageData.imageData.getPointData().getScalars();
          if (scalars && scalars.getRange) range = scalars.getRange();
        }
        if (!range && imageData.voxelManager && imageData.voxelManager.getRange) {
          range = imageData.voxelManager.getRange();
        }
        if (!range && imageData.scalarData && imageData.scalarData.length) {
          let min = Infinity;
          let max = -Infinity;
          const data = imageData.scalarData;
          // Sample rather than walk a few hundred million voxels.
          const stride = Math.max(1, Math.floor(data.length / 200000));
          for (let i = 0; i < data.length; i += stride) {
            const v = data[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          range = [min, max];
        }

        if (range) {
          add('VOXEL RANGE', range[0] + ' .. ' + range[1]);
          if (range[0] === range[1]) {
            lines.push('>> Data is uniform. Windowing cannot help.');
          }
        } else {
          lines.push('Could not read voxel range.');
        }

        add('Data type', imageData.scalarData && imageData.scalarData.constructor.name);
        if (imageData.preScale) {
          add('Prescaled', String(imageData.preScale.scaled));
        }
      } else {
        lines.push('No viewport image data.');
      }
    } catch (e) {
      lines.push('Pixel read failed: ' + e.message);
    }

    if (capturedErrors.length) {
      lines.push('--- errors ---');
      capturedErrors.forEach(function (e) {
        lines.push(e);
      });
    }

    return lines;
  }

  // --- in-app settings panel -------------------------------------------------
  // The packaged apps have no address bar, so URL parameters are not reachable.
  // This is a deliberately dependency-free overlay rather than an OHIF React
  // component: OHIF's internal UI moves fast between releases, and keeping this
  // outside the component tree means rebasing onto a newer OHIF will not break
  // it.
  function mountSettingsPanel() {
    if (document.getElementById('cbct-quality-root')) return;

    const root = document.createElement('div');
    root.id = 'cbct-quality-root';

    const style = document.createElement('style');
    style.textContent = `
      #cbct-quality-root { position: fixed; inset: auto 0 0 auto; z-index: 2147483000;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      #cbct-quality-btn { position: fixed; right: 14px; bottom: 14px; width: 44px;
        height: 44px; border-radius: 50%; border: 1px solid #3a4a5e;
        background: #10202e; color: #cfe3f5; font-size: 19px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 2px 10px rgba(0,0,0,.45); }
      #cbct-quality-btn:hover { background: #17304a; }
      #cbct-quality-panel { position: fixed; right: 14px; bottom: 68px; width: 310px;
        max-width: calc(100vw - 28px); max-height: calc(100vh - 100px);
        overflow-y: auto; background: #0d1a26; color: #dbe8f4;
        border: 1px solid #33475c; border-radius: 10px; padding: 14px;
        box-shadow: 0 6px 26px rgba(0,0,0,.55); display: none; }
      #cbct-quality-panel.open { display: block; }
      #cbct-quality-panel h3 { margin: 0 0 4px; font-size: 15px; font-weight: 600; }
      #cbct-quality-panel .sub { font-size: 11.5px; color: #8fa6bc; margin-bottom: 12px;
        line-height: 1.45; }
      #cbct-quality-panel label { display: block; border: 1px solid #2b3d50;
        border-radius: 7px; padding: 9px 10px; margin-bottom: 7px; cursor: pointer; }
      #cbct-quality-panel label:hover { border-color: #4a6a8a; background: #122435; }
      #cbct-quality-panel label.active { border-color: #4b90c8; background: #12283b; }
      #cbct-quality-panel .name { font-size: 13px; font-weight: 500; }
      #cbct-quality-panel .hint { font-size: 11px; color: #8fa6bc; margin-top: 3px;
        line-height: 1.4; }
      #cbct-quality-panel input { margin-right: 7px; accent-color: #4b90c8; }
      #cbct-quality-panel .foot { font-size: 10.5px; color: #7b90a5; margin-top: 10px;
        border-top: 1px solid #253748; padding-top: 9px; line-height: 1.5; }
      #cbct-wl { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
      #cbct-wl .wl { display: flex; flex-direction: column; align-items: flex-start;
        gap: 2px; background: #14293c; color: #dbe8f4; border: 1px solid #2b3d50;
        border-radius: 7px; padding: 8px 9px; font-size: 12.5px; font-weight: 500;
        cursor: pointer; text-align: left; font-family: inherit; }
      #cbct-wl .wl:hover { border-color: #4b90c8; background: #17324a; }
      #cbct-wl .wl span { font-size: 10px; color: #8fa6bc; font-weight: 400; }
      #cbct-wl-msg { min-height: 14px; margin-top: 6px; }
      #cbct-diag-out { display: none; white-space: pre-wrap; word-break: break-all;
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        font-size: 10px; line-height: 1.5; color: #b9d0e4; background: #071522;
        border: 1px solid #253748; border-radius: 6px; padding: 8px;
        margin: 8px 0 0; max-height: 230px; overflow: auto; }
      #cbct-diag-out.shown { display: block; }
      #cbct-diag-copy { width: 100%; margin-top: 6px; }
    `;

    const button = document.createElement('button');
    button.id = 'cbct-quality-btn';
    button.type = 'button';
    button.title = 'Rendering quality';
    button.setAttribute('aria-label', 'Rendering quality settings');
    button.textContent = '\u2699';

    const panel = document.createElement('div');
    panel.id = 'cbct-quality-panel';

    const options = ['auto'].concat(PRESET_ORDER);
    const rows = options
      .map(function (key) {
        const isAuto = key === 'auto';
        const label = isAuto ? 'Automatic' : PRESETS[key].label;
        const hint = isAuto
          ? 'Choose based on this device. Currently: ' + PRESETS[resolvedKey].label
          : PRESETS[key].hint;
        const active = key === choice ? ' active' : '';
        const checked = key === choice ? ' checked' : '';
        return (
          '<label class="' + active.trim() + '" data-key="' + key + '">' +
          '<div class="name"><input type="radio" name="cbct-q" value="' + key + '"' +
          checked + '>' + label + '</div>' +
          '<div class="hint">' + hint + '</div>' +
          '</label>'
        );
      })
      .join('');

    const detected = window.cbctQuality.detected;
    const detectedText =
      (detected.deviceMemoryGB ? detected.deviceMemoryGB + ' GB RAM' : 'RAM unknown') +
      ' · ' +
      (detected.cores ? detected.cores + ' cores' : 'cores unknown');

    const precisionState =
      force16Bit === null ? 'preset' : force16Bit ? 'on' : 'off';
    const precisionRows = [
      ['preset', 'Follow preset', 'Currently ' + (preferSizeOverAccuracy ? '8-bit' : '16-bit') + '.'],
      ['on', 'Force 16-bit', 'Full precision textures. Use if the image looks flat or uniformly grey.'],
      ['off', 'Force 8-bit', 'Half the GPU memory, less intensity detail.'],
    ]
      .map(function (row) {
        const active = row[0] === precisionState ? ' active' : '';
        const checked = row[0] === precisionState ? ' checked' : '';
        return (
          '<label class="' + active.trim() + '">' +
          '<div class="name"><input type="radio" name="cbct-p" value="' + row[0] + '"' +
          checked + '>' + row[1] + '</div>' +
          '<div class="hint">' + row[2] + '</div>' +
          '</label>'
        );
      })
      .join('');

    panel.innerHTML =
      '<h3>Rendering quality</h3>' +
      '<div class="sub">Lower settings use less memory and render faster. ' +
      'Higher settings are sharper but can fail on devices with limited GPU memory. ' +
      'Changing this reloads the viewer.</div>' +
      rows +
      '<h3 style="margin-top:14px">Texture precision</h3>' +
      '<div class="sub">Independent of the preset above. CBCT data covers a wide ' +
      'value range, and 8-bit textures can flatten it until everything looks the ' +
      'same shade of grey.</div>' +
      precisionRows +
      '<h3 style="margin-top:14px">Window / level</h3>' +
      '<div class="sub">Applies to the active viewport. If the scan looks like ' +
      'flat grey, start with Bone.</div>' +
      '<div id="cbct-wl">' +
      WL_PRESETS.map(function (wl, i) {
        return (
          '<button type="button" class="wl" data-wl="' + i + '">' +
          wl.name + '<span>W ' + wl.window + ' / L ' + wl.level + '</span></button>'
        );
      }).join('') +
      '</div>' +
      '<div id="cbct-wl-msg" class="hint"></div>' +
      '<h3 style="margin-top:14px">Diagnostics</h3>' +
      '<div class="sub">Reads what is actually in the loaded data.</div>' +
      '<button type="button" id="cbct-diag-run" class="wl" style="width:100%">Run diagnostics</button>' +
      '<pre id="cbct-diag-out"></pre>' +
      '<div class="foot">Detected: ' + detectedText +
      '<br>Not a certified medical device. Do not use as the sole basis for diagnosis.</div>';

    button.addEventListener('click', function () {
      panel.classList.toggle('open');
    });

    panel.addEventListener('click', function (event) {
      if (event.target && event.target.id === 'cbct-diag-run') {
        const out = panel.querySelector('#cbct-diag-out');
        const report = collectDiagnostics();
        out.textContent = report.join('\n');
        out.classList.add('shown');

        let copy = panel.querySelector('#cbct-diag-copy');
        if (!copy) {
          copy = document.createElement('button');
          copy.type = 'button';
          copy.id = 'cbct-diag-copy';
          copy.className = 'wl';
          copy.textContent = 'Copy report';
          copy.addEventListener('click', function () {
            const text = out.textContent;
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(text).then(
                function () { copy.textContent = 'Copied'; },
                function () { copy.textContent = 'Copy failed — select the text above'; }
              );
            } else {
              copy.textContent = 'Select the text above to copy';
            }
          });
          out.parentNode.insertBefore(copy, out.nextSibling);
        }
        return;
      }

      const target = event.target.closest ? event.target.closest('.wl') : null;
      if (!target || !target.hasAttribute('data-wl')) return;
      const wl = WL_PRESETS[Number(target.getAttribute('data-wl'))];
      const message = applyWindowLevel(wl.window, wl.level);
      const box = panel.querySelector('#cbct-wl-msg');
      if (box) {
        box.textContent = message || 'Applied ' + wl.name + '.';
      }
    });

    panel.addEventListener('change', function (event) {
      const target = event.target;
      if (target && target.name === 'cbct-q') {
        window.cbctQuality.set(target.value);
      }
      if (target && target.name === 'cbct-p') {
        window.cbctQuality.setForce16Bit(
          target.value === 'preset' ? null : target.value === 'on'
        );
      }
    });

    document.addEventListener('click', function (event) {
      if (!panel.classList.contains('open')) return;
      if (panel.contains(event.target) || button.contains(event.target)) return;
      panel.classList.remove('open');
    });

    root.appendChild(style);
    root.appendChild(button);
    root.appendChild(panel);
    document.body.appendChild(root);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSettingsPanel);
  } else {
    mountSettingsPanel();
  }
})();
