<script lang="ts">
  import { initialsOf } from '../collaboration/collaboration-text';
  import { personColorOf } from '../theme/person-colors';

  let { name, color, locale }: { name: string; color: number; locale: string } = $props();
</script>

<span class="badge" style:background-color={personColorOf(color)} aria-hidden="true"
  >{initialsOf(name, locale)}</span
>

<style>
  .badge {
    width: 28px;
    height: 28px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--color-action-text);
    border-radius: 50%;
  }
</style>
