'use strict';

import { waitForSettings, trackFields } from '../common/settings.js';


// Wait for settings to be ready, then track fields changes (to persist settings).
waitForSettings().then(() => trackFields());
