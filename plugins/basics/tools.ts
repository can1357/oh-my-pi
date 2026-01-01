import type { CustomToolFactory } from '@mariozechner/pi-coding-agent'
import globFactory from './glob.js'
import grepFactory from './grep.js'
import notebookFactory from './notebook.js'
import runtime from './runtime.json'
import sdFactory from './sd.js'
import sgFactory from './sg.js'

const FEATURE_MAP: Record<string, CustomToolFactory> = {
   grep: grepFactory,
   glob: globFactory,
   'replace-all': sdFactory,
   ast: sgFactory,
}

const factory: CustomToolFactory = pi => {
   const enabledFeatures = new Set(runtime.features ?? [])
   const tools = []

   // Always include notebook (no feature flag)
   const notebook = notebookFactory(pi)
   if (notebook) tools.push(...(Array.isArray(notebook) ? notebook : [notebook]))

   // Load feature-flagged tools
   for (const [feature, factoryFn] of Object.entries(FEATURE_MAP)) {
      if (!enabledFeatures.has(feature)) continue

      const result = factoryFn(pi)
      if (result) tools.push(...(Array.isArray(result) ? result : [result]))
   }

   return tools
}

export default factory
