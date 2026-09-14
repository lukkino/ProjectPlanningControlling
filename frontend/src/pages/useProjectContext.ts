import { useOutletContext } from 'react-router-dom'
import type { ProjectDetail } from '../api/types'

export function useProjectContext() {
  return useOutletContext<{ project: ProjectDetail }>()
}
