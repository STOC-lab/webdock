<?php
/**
 * Plugin Name: WEBドック セキュリティ強化
 * Description: WordPressのバージョン表示(generatorタグ・wp-includesの?ver=)を外部から見えないようにします。
 * 置き場所: wp-content/mu-plugins/webdock-hardening.php (mu-pluginsフォルダが無ければ作成)
 * ※ mu-plugins に置いたファイルは自動で有効になり、テーマ更新でも消えません。
 */

if (!defined('ABSPATH')) { exit; }

// <meta name="generator" content="WordPress x.x"> を出さない
remove_action('wp_head', 'wp_generator');
add_filter('the_generator', '__return_empty_string');

// CSS/JSのURL末尾の ?ver=(WordPress本体のバージョン)を外す
function webdock_remove_ver_query($src) {
    if ($src && strpos($src, 'ver=') !== false) {
        $src = remove_query_arg('ver', $src);
    }
    return $src;
}
add_filter('style_loader_src', 'webdock_remove_ver_query', 9999);
add_filter('script_loader_src', 'webdock_remove_ver_query', 9999);
