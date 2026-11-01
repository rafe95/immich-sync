<script>
  // Stand-in for a whole screen in shell tests: renders only its name.
  let { name } = $props();
</script>

<div data-screen={name}>{name}</div>
