novera
{% comment %}
Renders a media

Accepts:

- media: {Object or String} Media object or video url
- type: {String} Type of media. Example: 'youtube', 'model', 'external_video', 'image', 'video', 'vimeo' (optional)
- class: {String} Adds a media class to the media element (optional)
- enable_video_looping: {Boolean} Set looping for video. Default: false (optional)
- controls: {Boolean} Set controls for video. Default: false (optional)
- muted: {Boolean} Set muted for video. Default: false (optional)
- autoplay: {Boolean} Set autoplay for video. Default: false (optional)
- media_aspect_ratio: {Number} Aspect ratio of the media (optional)

Usage:

{% render 'media',
    media: media,
    type: 'video',
    class: 'media',
    enable_video_looping: true,
    controls: true,
    muted: true,
    autoplay: false
  %}
{% endcomment %}

{% liquid
  assign loop = ''
  if enable_video_looping
    assign loop = '&loop=1&playlist=' | append: media.id
  endif
  assign controls = controls | default: true, allow_false: true
  assign muted = muted | default: true, allow_false: true
  assign autoplay = autoplay | default: false
%}

<div class='xo-media {{ class }}' style='--media-aspect-ratio: {{ media_aspect_ratio }}'>
  {% case type %}
    {% when 'video' %}
      <xo-intersection-video
        class='xo-embed-responsive'
      >
        {{ media | video_tag: image_size: '1100x', loop: enable_video_looping, controls: controls, muted: muted, autoplay: autoplay }}
      </xo-intersection-video>
    {% when 'vimeo' %}
      <xo-intersection-video
        class='xo-embed-responsive'
      >
        <iframe
          src='https://player.vimeo.com/video/{{ media.id }}?autoplay=1{{ loop }}&muted=0'
          allow='autoplay; encrypted-media'
          allowfullscreen
          title='{{ media.alt | escape }}'
        ></iframe>
      </xo-intersection-video>

    {% when 'youtube' %}
      <xo-intersection-video
        class='xo-embed-responsive'
      >
        <iframe
          src='https://www.youtube.com/embed/{{ media.id }}?autoplay={{autoplay}}{{loop}}&mute=1&controls=1&iv_load_policy=1&disablekb=1&playlist={{ media.id }}&modestbranding=1&playsinline=1'
          allow='autoplay; encrypted-media'
          allowfullscreen
          title='{{ media.alt | escape }}'
        ></iframe>
      </xo-intersection-video>

    {% when 'image' %}
      {% render 'image', image: media, media_aspect_ratio: media_aspect_ratio %}

    {% when 'model' %}
      {{ media | media_tag: image_size: '2048x', toggleable: true }}

    {% when 'external_video' %}
      <xo-intersection-video class='xo-embed-responsive'>
        {%- if media.host == 'youtube' -%}
          {{ media | external_video_url: autoplay: autoplay, loop: enable_video_looping, playlist: media.external_id }}
        {%- else -%}
          {{ media | external_video_url: autoplay: autoplay, loop: enable_video_looping }}
        {%- endif -%}
      </xo-intersection-video>

{% endcase %}

</div>

primecue
{% comment %}
Renders a media

Accepts:

- media: {Object or String} Media object or video url
- type: {String} Type of media. Example: 'youtube', 'model', 'external_video', 'image', 'video', 'vimeo' (optional)
- class: {String} Adds a media class to the media element (optional)
- enable_video_looping: {Boolean} Set looping for video. Default: false (optional)
- controls: {Boolean} Set controls for video. Default: false (optional)
- muted: {Boolean} Set muted for video. Default: false (optional)
- autoplay: {Boolean} Set autoplay for video. Default: false (optional)
- media_aspect_ratio: {Number} Aspect ratio of the media (optional)

Usage:

{% render 'media',
    media: media,
    type: 'video',
    class: 'media',
    enable_video_looping: true,
    controls: true,
    muted: true,
    autoplay: false
  %}
{% endcomment %}

{% liquid
  assign loop = ''
  if enable_video_looping
    assign loop = '&loop=1&playlist=' | append: media.id
  endif
  assign controls = controls | default: true, allow_false: true
  assign muted = muted | default: true, allow_false: true
  assign autoplay = autoplay | default: false
%}

<div class='xo-media {{ class }}' style='--media-aspect-ratio: {{ media_aspect_ratio }}'>
  {% case type %}
    {% when 'video' %}
      <xo-intersection-video
        class='xo-embed-responsive'
      >
        {{ media | video_tag: image_size: '1100x', loop: enable_video_looping, controls: controls, muted: muted, autoplay: autoplay }}
      </xo-intersection-video>
    {% when 'vimeo' %}
      <xo-intersection-video
        class='xo-embed-responsive'
      >
        <iframe
          src='https://player.vimeo.com/video/{{ media.id }}?autoplay=1{{ loop }}&muted=0'
          allow='autoplay; encrypted-media'
          allowfullscreen
          title='{{ media.alt | escape }}'
        ></iframe>
      </xo-intersection-video>

    {% when 'youtube' %}
      <xo-intersection-video
        class='xo-embed-responsive'
      >
        <iframe
          src='https://www.youtube.com/embed/{{ media.id }}?autoplay={{autoplay}}{{loop}}&mute=1&controls=1&iv_load_policy=1&disablekb=1&playlist={{ media.id }}&modestbranding=1&playsinline=1'
          allow='autoplay; encrypted-media'
          allowfullscreen
          title='{{ media.alt | escape }}'
        ></iframe>
      </xo-intersection-video>

    {% when 'image' %}
      {% render 'image', image: media, media_aspect_ratio: media_aspect_ratio %}

    {% when 'model' %}
      {{ media | media_tag: image_size: '2048x', toggleable: true }}

    {% when 'external_video' %}
      <xo-intersection-video class='xo-embed-responsive'>
        {%- if media.host == 'youtube' -%}
          {{ media | external_video_url: autoplay: autoplay, loop: enable_video_looping, playlist: media.external_id }}
        {%- else -%}
          {{ media | external_video_url: autoplay: autoplay, loop: enable_video_looping }}
        {%- endif -%}
      </xo-intersection-video>

{% endcase %}

</div>
