import { describe, expect, it } from 'vitest'
import { projectFacets } from '@/features/palette/providers/projectFacets'
import type { ProjectFacetSource } from '@/features/palette/providers/projectFacets'

function source(overrides: Partial<ProjectFacetSource> = {}): ProjectFacetSource {
  return {
    name: 'acme/api',
    path: '~/Documents/freelance/mabes/superapps/core',
    machineId: 'm1',
    ...overrides,
  }
}

const machines = [{ id: 'm1', name: 'home-laptop' }]

describe('projectFacets', () => {
  describe('machineName', () => {
    it('resolves the machine name from a matching machineId', () => {
      expect(projectFacets(source(), machines).machineName).toBe('home-laptop')
    })

    it('falls back to "local" for an unknown machineId', () => {
      expect(projectFacets(source({ machineId: 'nonexistent' }), machines).machineName).toBe('local')
    })

    it('falls back to "local" for an empty machineId', () => {
      expect(projectFacets(source({ machineId: '' }), machines).machineName).toBe('local')
    })
  })

  describe('elidePath (via subtitle)', () => {
    it('elides a path with more than two segments to …/<last two>', () => {
      const facets = projectFacets(source({ path: '~/Documents/freelance/mabes/superapps/core' }), machines)
      expect(facets.subtitle).toBe('home-laptop · …/superapps/core')
    })

    it('elides a two-segment-after-~-split path to …/<last two> when more than two segments remain', () => {
      // '~/Documents/deps' splits into ['~', 'Documents', 'deps'] -> 3 segments, elided
      const facets = projectFacets(source({ path: '~/Documents/deps' }), machines)
      expect(facets.subtitle).toBe('home-laptop · …/Documents/deps')
    })

    it('leaves a path with exactly two segments unchanged', () => {
      const facets = projectFacets(source({ path: 'a/b' }), machines)
      expect(facets.subtitle).toBe('home-laptop · a/b')
    })

    it('leaves a path with one segment unchanged', () => {
      const facets = projectFacets(source({ path: '/srv' }), machines)
      expect(facets.subtitle).toBe('home-laptop · /srv')
    })

    it('drops empty segments before counting', () => {
      // '/srv' splits into ['', 'srv'] -> drop empty -> 1 segment -> unchanged
      const facets = projectFacets(source({ path: '/srv' }), machines)
      expect(facets.subtitle).toContain('/srv')
    })
  })

  describe('subtitle', () => {
    it('joins machineName and elided path with a middle dot', () => {
      const facets = projectFacets(source({ path: '~/Documents/freelance/mabes/superapps/core' }), machines)
      expect(facets.subtitle).toBe('home-laptop · …/superapps/core')
    })

    it('is just machineName when path is empty', () => {
      const facets = projectFacets(source({ path: '' }), machines)
      expect(facets.subtitle).toBe('home-laptop')
    })
  })

  describe('keywords', () => {
    it('is [machineName]', () => {
      expect(projectFacets(source(), machines).keywords).toEqual(['home-laptop'])
    })
  })

  describe('literalKeywords', () => {
    it('is [path] when path is non-empty, carrying the full un-elided path', () => {
      const facets = projectFacets(source({ path: '~/Documents/freelance/mabes/superapps/core' }), machines)
      expect(facets.literalKeywords).toEqual(['~/Documents/freelance/mabes/superapps/core'])
    })

    it('is [] when path is empty', () => {
      expect(projectFacets(source({ path: '' }), machines).literalKeywords).toEqual([])
    })
  })
})
